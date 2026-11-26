import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { test as base, expect, DB_URL } from './db.fixture';

// Concurrency: two sessions, "a" and "b", each with its own connection, run
// interleaved transactions while the worker connection "db" watches.
//
// These tests commit and hold locks across connections, so they run in the
// "db-serial" project: after every "db" test, one at a time. They work on
// products and customers they create, and delete them at the end.
//
// No fixed sleeps: when a step must wait for a lock, the test polls
// pg_blocking_pids() until the database reports the wait.
//
//   40001 serialization_failure   40P01 deadlock_detected
//   55P03 lock_not_available      SH001 insufficient stock   SH005 stale version

type Session = { client: Client; pid: number };

// Products and customers made for one test, removed when it ends.
class Scratch {
  private products: number[] = [];
  private customers: number[] = [];
  constructor(private db: Client) {}

  async product(stock: number): Promise<number> {
    const { rows } = await this.db.query(
      `INSERT INTO products (sku, name, price, stock) VALUES ($1, 'Race item', 10, $2) RETURNING id`,
      [`RC-${randomUUID().slice(0, 8)}`, stock],
    );
    this.products.push(rows[0].id);
    return rows[0].id;
  }

  async customer(): Promise<number> {
    const { rows } = await this.db.query(
      `INSERT INTO customers (name, email) VALUES ('Race test', $1) RETURNING id`,
      [`race-${randomUUID().slice(0, 8)}@example.com`],
    );
    this.customers.push(rows[0].id);
    return rows[0].id;
  }

  async cleanup(): Promise<void> {
    await this.db.query('DELETE FROM orders WHERE customer_id = ANY($1)', [this.customers]);
    await this.db.query('DELETE FROM products WHERE id = ANY($1)', [this.products]);
    await this.db.query('DELETE FROM customers WHERE id = ANY($1)', [this.customers]);
  }
}

async function openSession(): Promise<Session> {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  const { rows } = await client.query('SELECT pg_backend_pid() AS pid');
  return { client, pid: rows[0].pid };
}

async function closeSession({ client }: Session): Promise<void> {
  await client.query('ROLLBACK').catch(() => {}); // release locks if a test failed mid-way
  await client.end();
}

// a and b depend on scratch, so they are closed (and their locks released)
// before scratch deletes the test data.
const test = base.extend<{ scratch: Scratch; a: Session; b: Session }>({
  scratch: async ({ db }, use) => {
    const scratch = new Scratch(db);
    await use(scratch);
    await scratch.cleanup();
  },
  a: async ({ scratch: _scratch }, use) => {
    const session = await openSession();
    await use(session);
    await closeSession(session);
  },
  b: async ({ scratch: _scratch }, use) => {
    const session = await openSession();
    await use(session);
    await closeSession(session);
  },
});

test.describe.configure({ mode: 'serial' });

// Starts a query that is expected to block, without letting a rejection go
// unhandled while the test does other things. The outcome has either a value
// or an error, so a test asserts on both without an if.
type PgError = { code?: string; message: string; detail?: string };
type Outcome<T> = { value?: T; error?: PgError };
function start<T>(promise: Promise<T>): Promise<Outcome<T>> {
  return promise.then(
    (value) => ({ value }),
    (error: PgError) => ({ error }),
  );
}

// Waits until the database reports that `waiter` is blocked by `holder`.
async function waitUntilBlocked(db: Client, waiter: Session, holder: Session): Promise<void> {
  await expect
    .poll(async () => (await db.query('SELECT pg_blocking_pids($1) AS pids', [waiter.pid])).rows[0].pids, {
      message: `session ${waiter.pid} should be waiting for a lock held by ${holder.pid}`,
      timeout: 5_000,
      intervals: [20],
    })
    .toContain(holder.pid);
}

async function stockOf(db: Client, productId: number): Promise<number> {
  const { rows } = await db.query('SELECT stock FROM products WHERE id = $1', [productId]);
  return rows[0].stock;
}

const readStock = 'SELECT stock FROM products WHERE id = $1';
const items = (...productIds: number[]) => JSON.stringify(productIds.map((id) => ({ product_id: id, quantity: 1 })));

test.describe('lost update', () => {
  test('a read-modify-write done by the application loses an update', async ({ db, scratch, a, b }) => {
    const product = await scratch.product(5);
    await a.client.query('BEGIN');
    await b.client.query('BEGIN');

    // Both read 5 and compute 4 in the application.
    const seenByA = (await a.client.query(readStock, [product])).rows[0].stock;
    const seenByB = (await b.client.query(readStock, [product])).rows[0].stock;
    expect([seenByA, seenByB]).toEqual([5, 5]);

    await a.client.query('UPDATE products SET stock = $2 WHERE id = $1', [product, seenByA - 1]);
    await a.client.query('COMMIT');
    await b.client.query('UPDATE products SET stock = $2 WHERE id = $1', [product, seenByB - 1]);
    await b.client.query('COMMIT');

    // Two units left the shelf, but the stock only went down by one.
    expect(await stockOf(db, product)).toBe(4);
  });

  test('an atomic UPDATE keeps both: the second one waits and works on the new value', async ({ db, scratch, a, b }) => {
    const product = await scratch.product(5);
    await a.client.query('BEGIN');
    await a.client.query('UPDATE products SET stock = stock - 1 WHERE id = $1', [product]);

    const second = start(b.client.query('UPDATE products SET stock = stock - 1 WHERE id = $1 RETURNING stock', [product]));
    await waitUntilBlocked(db, b, a);
    await a.client.query('COMMIT');

    // After the lock is released, READ COMMITTED re-reads the committed row
    // (4) and applies its own change to it.
    const outcome = await second;
    expect(outcome.error).toBeUndefined();
    expect(outcome.value?.rows[0].stock).toBe(3);
    expect(await stockOf(db, product)).toBe(3);
  });

  test('SELECT FOR UPDATE makes the second reader wait for the first writer', async ({ db, scratch, a, b }) => {
    const product = await scratch.product(5);
    await a.client.query('BEGIN');
    await b.client.query('BEGIN');

    const seenByA = (await a.client.query(`${readStock} FOR UPDATE`, [product])).rows[0].stock;
    const readByB = start(b.client.query(`${readStock} FOR UPDATE`, [product]));
    await waitUntilBlocked(db, b, a);

    await a.client.query('UPDATE products SET stock = $2 WHERE id = $1', [product, seenByA - 1]);
    await a.client.query('COMMIT');

    const outcome = await readByB;
    expect(outcome.error).toBeUndefined();
    const seenByB: number = outcome.value?.rows[0].stock;
    expect(seenByB).toBe(4); // not the stale 5
    await b.client.query('UPDATE products SET stock = $2 WHERE id = $1', [product, seenByB - 1]);
    await b.client.query('COMMIT');

    expect(await stockOf(db, product)).toBe(3);
  });

  test('REPEATABLE READ refuses to write over a change it did not see', async ({ db, scratch, a, b }) => {
    const product = await scratch.product(5);
    await b.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    expect((await b.client.query(readStock, [product])).rows[0].stock).toBe(5); // snapshot taken here

    await a.client.query('UPDATE products SET stock = 4 WHERE id = $1', [product]); // commits on its own

    await expect(b.client.query('UPDATE products SET stock = 4 WHERE id = $1', [product])).rejects.toMatchObject({
      code: '40001',
      message: 'could not serialize access due to concurrent update',
    });
    await b.client.query('ROLLBACK');
    expect(await stockOf(db, product)).toBe(4); // a retry would now read 4 and write 3
  });
});

test.describe('isolation levels', () => {
  test('READ COMMITTED: two reads in one transaction can return different values', async ({ scratch, a, b }) => {
    const product = await scratch.product(5);
    await b.client.query('BEGIN'); // READ COMMITTED is the default
    expect((await b.client.query(readStock, [product])).rows[0].stock).toBe(5);

    await a.client.query('UPDATE products SET stock = 7 WHERE id = $1', [product]);

    expect((await b.client.query(readStock, [product])).rows[0].stock).toBe(7);
    await b.client.query('COMMIT');
  });

  test('REPEATABLE READ: the snapshot starts at the first query, not at BEGIN', async ({ db, scratch, a, b }) => {
    const product = await scratch.product(5);
    await b.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');

    await a.client.query('UPDATE products SET stock = 6 WHERE id = $1', [product]);
    // No query yet in b, so no snapshot: b still sees the change made after its BEGIN.
    expect((await b.client.query(readStock, [product])).rows[0].stock).toBe(6);

    await a.client.query('UPDATE products SET stock = 7 WHERE id = $1', [product]);
    // From now on b reads its snapshot.
    expect((await b.client.query(readStock, [product])).rows[0].stock).toBe(6);
    await b.client.query('COMMIT');

    expect(await stockOf(db, product)).toBe(7);
  });

  // The rule "one PENDING order per customer" is checked by the application:
  // count, and place the order if the count is 0. Two sessions that both count
  // before either writes see 0, and both place an order. No row is written by
  // both, so row locks do not help. Each orders a different product, so
  // place_order's own locks do not get in the way either.
  test('write skew: REPEATABLE READ lets both sessions break the rule', async ({ db, scratch, a, b }) => {
    const { outcomes, pending } = await raceForOnePendingOrder(db, scratch, a, b, 'REPEATABLE READ');

    expect(outcomes.map((o) => o.error)).toEqual([undefined, undefined]);
    expect(pending).toBe(2); // the rule is broken
  });

  test('write skew: SERIALIZABLE fails one session with 40001', async ({ db, scratch, a, b }) => {
    const { outcomes, pending } = await raceForOnePendingOrder(db, scratch, a, b, 'SERIALIZABLE');

    // SERIALIZABLE sees that each transaction read what the other wrote and
    // fails one. Retrying it would count 1 and place no order.
    const codes = outcomes.filter((o) => o.error).map((o) => o.error?.code);
    expect(codes).toEqual(['40001']);
    expect(pending).toBe(1);
  });
});

// Both sessions count the customer's PENDING orders, both see 0, then each
// places an order and commits. Returns how each session ended and how many
// PENDING orders were saved.
async function raceForOnePendingOrder(
  db: Client,
  scratch: Scratch,
  a: Session,
  b: Session,
  level: 'REPEATABLE READ' | 'SERIALIZABLE',
): Promise<{ outcomes: Outcome<void>[]; pending: number }> {
  const customer = await scratch.customer();
  const [p1, p2] = [await scratch.product(5), await scratch.product(5)];
  const countPending = `SELECT COUNT(*)::int AS n FROM orders WHERE customer_id = $1 AND status = 'PENDING'`;

  await a.client.query(`BEGIN ISOLATION LEVEL ${level}`);
  await b.client.query(`BEGIN ISOLATION LEVEL ${level}`);
  expect((await a.client.query(countPending, [customer])).rows[0].n).toBe(0);
  expect((await b.client.query(countPending, [customer])).rows[0].n).toBe(0);

  const placeAndCommit = (s: Session, product: number) =>
    start(
      (async () => {
        await s.client.query('CALL place_order($1, $2)', [customer, items(product)]);
        await s.client.query('COMMIT');
      })(),
    );
  const outcomes = [await placeAndCommit(a, p1), await placeAndCommit(b, p2)];
  await a.client.query('ROLLBACK').catch(() => {});
  await b.client.query('ROLLBACK').catch(() => {});

  const pending: number = (await db.query(countPending, [customer])).rows[0].n;
  return { outcomes, pending };
}

test.describe('deadlocks', () => {
  test('two transactions locking rows in opposite order deadlock, and one is aborted', async ({ db, scratch, a, b }) => {
    const [x, y] = [await scratch.product(10), await scratch.product(10)];
    await a.client.query('BEGIN');
    await b.client.query('BEGIN');
    await a.client.query('UPDATE products SET stock = stock - 1 WHERE id = $1', [x]);
    await b.client.query('UPDATE products SET stock = stock - 1 WHERE id = $1', [y]);

    const aWantsY = start(a.client.query('UPDATE products SET stock = stock - 1 WHERE id = $1', [y]));
    await waitUntilBlocked(db, a, b);
    const bWantsX = start(b.client.query('UPDATE products SET stock = stock - 1 WHERE id = $1', [x]));

    // After deadlock_timeout (1s by default) PostgreSQL finds the cycle and
    // aborts one of the two, which lets the other go on.
    const outcomes = await Promise.all([aWantsY, bWantsX]);
    const codes = outcomes.map((o) => o.error?.code).sort();
    expect(codes).toEqual(['40P01', undefined]); // one aborted, one went on
  });

  test('place_order locks in id order, so opposite item orders wait instead of deadlocking', async ({ db, scratch, a, b }) => {
    const customer = await scratch.customer();
    const [x, y] = [await scratch.product(10), await scratch.product(10)];

    await a.client.query('BEGIN');
    await a.client.query('CALL place_order($1, $2)', [customer, items(x, y)]);
    // b lists the items the other way round, but place_order locks x first
    // anyway, so b waits for a without holding y.
    const second = start(b.client.query('CALL place_order($1, $2)', [customer, items(y, x)]));
    await waitUntilBlocked(db, b, a);
    await a.client.query('COMMIT');

    expect((await second).error).toBeUndefined();
    expect([await stockOf(db, x), await stockOf(db, y)]).toEqual([8, 8]);
  });
});

test.describe('the last unit', () => {
  test('two customers race for it: one order wins, the other gets SH001', async ({ db, scratch, a, b }) => {
    const product = await scratch.product(1);
    const [c1, c2] = [await scratch.customer(), await scratch.customer()];

    await a.client.query('BEGIN');
    await a.client.query('CALL place_order($1, $2)', [c1, items(product)]);

    const second = start(b.client.query('CALL place_order($1, $2)', [c2, items(product)]));
    await waitUntilBlocked(db, b, a);
    await a.client.query('COMMIT');

    // b waited on the row lock, then read the committed stock: 0.
    const outcome = await second;
    expect(outcome.error).toMatchObject({ code: 'SH001', detail: 'requested 1, in stock 0' });

    expect(await stockOf(db, product)).toBe(0);
    const { rows } = await db.query(
      'SELECT COUNT(*)::int AS orders FROM order_items WHERE product_id = $1',
      [product],
    );
    expect(rows[0].orders).toBe(1);
  });
});

test.describe('not waiting', () => {
  test('FOR UPDATE NOWAIT fails at once on a locked row', async ({ scratch, a, b }) => {
    const product = await scratch.product(5);
    await a.client.query('BEGIN');
    await a.client.query(`${readStock} FOR UPDATE`, [product]);

    await expect(b.client.query(`${readStock} FOR UPDATE NOWAIT`, [product])).rejects.toMatchObject({
      code: '55P03',
    });
  });

  test('lock_timeout gives up after a limit instead of waiting forever', async ({ scratch, a, b }) => {
    const product = await scratch.product(5);
    await a.client.query('BEGIN');
    await a.client.query(`${readStock} FOR UPDATE`, [product]);

    await b.client.query(`SET lock_timeout = '200ms'`);
    await expect(b.client.query('UPDATE products SET stock = 0 WHERE id = $1', [product])).rejects.toMatchObject({
      code: '55P03',
      message: 'canceling statement due to lock timeout',
    });
  });
});

test.describe('optimistic locking', () => {
  const readVersion = 'SELECT version FROM products WHERE id = $1';

  test('the second save with a stale version fails with SH005', async ({ db, scratch, a, b }) => {
    const product = await scratch.product(5);
    // Two people open the edit form: both see the same version, no lock held.
    const version = (await a.client.query(readVersion, [product])).rows[0].version;
    expect((await b.client.query(readVersion, [product])).rows[0].version).toBe(version);

    const saved = await a.client.query('SELECT update_product_price($1, 12, $2) AS version', [product, version]);
    expect(saved.rows[0].version).toBe(version + 1);

    await expect(
      b.client.query('SELECT update_product_price($1, 13, $2)', [product, version]),
    ).rejects.toMatchObject({
      code: 'SH005',
      detail: `expected version ${version}, current version ${version + 1}`,
      hint: 'Read the product again and repeat the change.',
    });

    const { rows } = await db.query('SELECT price FROM products WHERE id = $1', [product]);
    expect(rows[0].price).toBe('12.00');
  });

  test('any change bumps the version, so a sale also makes an open form stale', async ({ scratch, a, b }) => {
    const product = await scratch.product(5);
    const customer = await scratch.customer();
    const version = (await a.client.query(readVersion, [product])).rows[0].version;

    await b.client.query('CALL place_order($1, $2)', [customer, items(product)]); // stock 5 -> 4

    await expect(
      a.client.query('SELECT update_product_price($1, 12, $2)', [product, version]),
    ).rejects.toMatchObject({ code: 'SH005' });
  });

  test('an update that changes nothing keeps the version', async ({ db, scratch }) => {
    const product = await scratch.product(5);
    const before = (await db.query(readVersion, [product])).rows[0].version;
    await db.query('UPDATE products SET price = price WHERE id = $1', [product]);
    expect((await db.query(readVersion, [product])).rows[0].version).toBe(before);
  });
});

test.describe('advisory lock', () => {
  test('only one session refreshes daily_sales at a time', async ({ a, b }) => {
    await a.client.query('BEGIN');
    expect((await a.client.query('SELECT refresh_daily_sales() AS ran')).rows[0].ran).toBe(true);

    // a still holds the advisory lock: b returns at once instead of waiting.
    expect((await b.client.query('SELECT refresh_daily_sales() AS ran')).rows[0].ran).toBe(false);

    await a.client.query('COMMIT'); // the _xact_ lock is released here
    expect((await b.client.query('SELECT refresh_daily_sales() AS ran')).rows[0].ran).toBe(true);
  });
});
