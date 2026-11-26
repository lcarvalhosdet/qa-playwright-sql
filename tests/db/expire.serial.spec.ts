import { randomUUID } from 'node:crypto';
import { Client, type NoticeMessage } from 'pg';
import { test, expect, DB_URL } from './db.fixture';

// expire_pending_orders commits after each batch, so it cannot run inside the
// rolled-back transaction the other tests use. This file:
//   - runs in the "db-serial" project, which starts after every "db" test has
//     finished and uses one worker (see playwright.config.ts), so no other test
//     sees its data;
//   - creates its own customer, product and orders, dated 1999 so that no seed
//     order falls before the cutoff;
//   - deletes everything it created at the end. The audit_log rows these
//     changes produce stay: the log is append-only.
test.describe.configure({ mode: 'serial' });

const cutoff = '2000-01-01';

type Fixture = { customerId: number; productId: number; orderIds: number[] };

// Creates a customer, a product with no stock and one order per entry, each
// with one unit of the product. All in one transaction, because the deferred
// trigger orders_must_have_items rejects, at COMMIT, an order without items.
async function createOrders(db: Client, orders: { status: string; createdAt: string }[]): Promise<Fixture> {
  const runId = randomUUID().slice(0, 8);
  await db.query('BEGIN');
  try {
    const customer = await db.query(
      `INSERT INTO customers (name, email) VALUES ('Commit test', $1) RETURNING id`,
      [`commit-${runId}@example.com`],
    );
    const product = await db.query(
      `INSERT INTO products (sku, name, price, stock) VALUES ($1, 'Commit item', 10, 0) RETURNING id`,
      [`CT-${runId}`],
    );
    const customerId: number = customer.rows[0].id;
    const productId: number = product.rows[0].id;

    const inserted = await db.query(
      `INSERT INTO orders (customer_id, status, created_at)
       SELECT $1, o.status::order_status, o.created_at::timestamptz
       FROM jsonb_to_recordset($2) AS o(status TEXT, created_at TEXT, n INT)
       ORDER BY o.n
       RETURNING id`,
      [customerId, JSON.stringify(orders.map((o, n) => ({ status: o.status, created_at: o.createdAt, n })))],
    );
    const orderIds: number[] = inserted.rows.map((row) => row.id).sort((a, b) => a - b);
    await db.query(
      `INSERT INTO order_items (order_id, product_id, quantity, unit_price)
       SELECT id, $2, 1, 10 FROM unnest($1::int[]) AS id`,
      [orderIds, productId],
    );
    await db.query('COMMIT');
    return { customerId, productId, orderIds };
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

async function removeOrders(db: Client, { customerId, productId }: Fixture): Promise<void> {
  await db.query('DELETE FROM orders WHERE customer_id = $1', [customerId]); // items go by CASCADE
  await db.query('DELETE FROM products WHERE id = $1', [productId]);
  await db.query('DELETE FROM customers WHERE id = $1', [customerId]);
}

test('expires old PENDING orders in batches, one transaction per batch', async ({ db }) => {
  // 5 old PENDING orders to expire, 1 old PAID order and 1 recent PENDING order to keep.
  const fixture = await createOrders(db, [
    { status: 'PENDING', createdAt: '1999-12-01' },
    { status: 'PENDING', createdAt: '1999-12-02' },
    { status: 'PENDING', createdAt: '1999-12-03' },
    { status: 'PENDING', createdAt: '1999-12-04' },
    { status: 'PENDING', createdAt: '1999-12-05' },
    { status: 'PAID', createdAt: '1999-12-06' },
    { status: 'PENDING', createdAt: new Date().toISOString() },
  ]);
  const oldPending = fixture.orderIds.slice(0, 5);
  const [oldPaid, recentPending] = fixture.orderIds.slice(5);

  try {
    // RAISE NOTICE messages arrive on the connection, one per batch.
    const notices: string[] = [];
    const onNotice = (notice: NoticeMessage) => notices.push(notice.message ?? '');
    db.on('notice', onNotice);
    let expired: number;
    try {
      const { rows } = await db.query('CALL expire_pending_orders($1, 2)', [cutoff]);
      expired = rows[0].p_expired;
    } finally {
      db.off('notice', onNotice);
    }

    expect(expired).toBe(5);
    expect(notices).toEqual([
      'expired 2 orders, 2 so far',
      'expired 2 orders, 4 so far',
      'expired 1 orders, 5 so far',
    ]);

    const { rows: statuses } = await db.query(
      'SELECT id, status FROM orders WHERE customer_id = $1 ORDER BY id',
      [fixture.customerId],
    );
    expect(statuses).toEqual([
      ...oldPending.map((id) => ({ id, status: 'CANCELLED' })),
      { id: oldPaid, status: 'PAID' },
      { id: recentPending, status: 'PENDING' },
    ]);

    // xmin is the id of the transaction that last wrote the row. Three batches
    // that each committed leave three different values on the five orders.
    const { rows: tx } = await db.query(
      'SELECT COUNT(DISTINCT xmin::text)::int AS transactions FROM orders WHERE id = ANY($1)',
      [oldPending],
    );
    expect(tx[0].transactions).toBe(3);

    // The audit trigger logged each cancellation in the transaction of its batch.
    const { rows: audit } = await db.query(
      `SELECT COUNT(*)::int AS rows, COUNT(DISTINCT transaction_id)::int AS transactions
       FROM audit_log
       WHERE table_name = 'orders' AND operation = 'UPDATE' AND row_id = ANY($1)`,
      [oldPending],
    );
    expect(audit[0]).toEqual({ rows: 5, transactions: 3 });

    // cancel_order put one unit back per expired order.
    const { rows: stock } = await db.query('SELECT stock FROM products WHERE id = $1', [fixture.productId]);
    expect(stock[0].stock).toBe(5);
  } finally {
    await removeOrders(db, fixture);
  }
});

test('finds nothing to expire when no order is older than the cutoff', async ({ db }) => {
  const { rows } = await db.query('CALL expire_pending_orders($1)', [cutoff]);
  expect(rows[0].p_expired).toBe(0);
});

test('skips orders another transaction has locked instead of waiting for them', async ({ db }) => {
  const fixture = await createOrders(db, [
    { status: 'PENDING', createdAt: '1999-11-01' },
    { status: 'PENDING', createdAt: '1999-11-02' },
  ]);
  const [lockedId, freeId] = fixture.orderIds;

  // A second connection, like another session working on the first order.
  const other = new Client({ connectionString: DB_URL });
  await other.connect();
  try {
    await other.query('BEGIN');
    await other.query('SELECT id FROM orders WHERE id = $1 FOR UPDATE', [lockedId]);

    // Without SKIP LOCKED this CALL would wait for the other transaction and
    // the test would time out. A lock_timeout turns that wait into a fast failure.
    await db.query(`SET lock_timeout = '2s'`);
    const { rows } = await db.query('CALL expire_pending_orders($1)', [cutoff]);
    expect(rows[0].p_expired).toBe(1);

    const { rows: statuses } = await db.query(
      'SELECT id, status FROM orders WHERE id = ANY($1) ORDER BY id',
      [[lockedId, freeId]],
    );
    expect(statuses).toEqual([
      { id: lockedId, status: 'PENDING' },
      { id: freeId, status: 'CANCELLED' },
    ]);
  } finally {
    await db.query('RESET lock_timeout');
    await other.query('ROLLBACK');
    await other.end();
    await removeOrders(db, fixture);
  }
});
