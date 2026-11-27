import fc from 'fast-check';
import type { Client } from 'pg';
import { test, expect, rolledBack } from './db.fixture';

// Model-based property test with fast-check.
//
// Instead of cases written by hand, fast-check generates random sequences of
// operations (place, pay and cancel orders) and runs each one against the
// database and against a model: a few lines of TypeScript that say what
// should happen. After every step the two must agree, on the outcome (success
// or the exact SQLSTATE) and on the state (stock, statuses, payments).
//
// When they disagree, fast-check shrinks the sequence to the shortest one
// that still fails and prints it, with the seed to replay it.
//
// Each run is one rolled-back transaction; each step runs in a savepoint, so
// a step that fails does not end the transaction.

const LIMIT = 3; // max_pending_orders of the test customer
const INITIAL_STOCK = [5, 2, 0]; // three products; the last one is sold out

type Item = { p: number; q: number }; // product index, quantity
type ModelOrder = { status: 'PENDING' | 'PAID' | 'CANCELLED'; items: Item[]; paid: boolean };
type Model = { stock: number[]; orders: ModelOrder[] };
type Real = { db: Client; customer: number; products: number[]; orders: number[] };

function same(actual: unknown, expected: unknown, what: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// Runs one statement in a savepoint; returns its rows, or the SQLSTATE it failed with.
async function attempt(db: Client, sql: string, params: unknown[]) {
  await db.query('SAVEPOINT step');
  try {
    const { rows } = await db.query(sql, params);
    await db.query('RELEASE SAVEPOINT step');
    return { code: null as string | null, rows };
  } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT step');
    return { code: (error as { code?: string }).code ?? 'unknown', rows: [] };
  }
}

// The database must match the model after every step.
async function checkState(m: Model, r: Real): Promise<void> {
  const stock = await r.db.query('SELECT stock FROM products WHERE id = ANY($1) ORDER BY id', [r.products]);
  same(stock.rows.map((row) => row.stock), m.stock, 'stock');

  const orders = await r.db.query('SELECT status FROM orders WHERE id = ANY($1) ORDER BY id', [r.orders]);
  same(orders.rows.map((row) => row.status), m.orders.map((o) => o.status), 'statuses');

  const payments = await r.db.query(
    `SELECT COUNT(*)::int AS n, COALESCE(bool_and(amount = order_total(order_id)), true) AS match
     FROM payments WHERE order_id = ANY($1)`,
    [r.orders],
  );
  same(payments.rows[0], { n: m.orders.filter((o) => o.paid).length, match: true }, 'payments');
}

// What place_order should do: the pending limit first (the trigger fires on
// the order's INSERT), then each item in order: stock, then duplicate.
function expectPlace(m: Model, items: Item[]): { code: string | null; stock?: number[] } {
  if (m.orders.filter((o) => o.status === 'PENDING').length >= LIMIT) return { code: 'SH006' };
  const stock = [...m.stock];
  const seen = new Set<number>();
  for (const item of items) {
    if (item.q > stock[item.p]) return { code: 'SH001' };
    if (seen.has(item.p)) return { code: '22023' };
    seen.add(item.p);
    stock[item.p] -= item.q;
  }
  return { code: null, stock };
}

class PlaceOrder implements fc.AsyncCommand<Model, Real> {
  constructor(readonly items: Item[]) {}
  check = () => true;
  async run(m: Model, r: Real): Promise<void> {
    const expected = expectPlace(m, this.items);
    const json = JSON.stringify(this.items.map((i) => ({ product_id: r.products[i.p], quantity: i.q })));
    const out = await attempt(r.db, 'CALL place_order($1, $2)', [r.customer, json]);
    same(out.code, expected.code, `${this} outcome`);
    if (expected.code === null) {
      m.stock = expected.stock!;
      m.orders.push({ status: 'PENDING', items: this.items, paid: false });
      r.orders.push(out.rows[0].p_order_id);
    }
    await checkState(m, r);
  }
  toString = () => `place(${this.items.map((i) => `p${i.p}x${i.q}`).join(' ')})`;
}

class Pay implements fc.AsyncCommand<Model, Real> {
  constructor(readonly ref: number) {}
  check = (m: Readonly<Model>) => m.orders.length > 0;
  async run(m: Model, r: Real): Promise<void> {
    const i = this.ref % m.orders.length;
    const order = m.orders[i];
    const expected = order.status === 'PENDING' ? null : 'SH002';
    const out = await attempt(r.db, `CALL pay_order($1, 'PIX')`, [r.orders[i]]);
    same(out.code, expected, `pay(order ${i}, ${order.status}) outcome`);
    if (expected === null) {
      order.status = 'PAID';
      order.paid = true;
    }
    await checkState(m, r);
  }
  toString = () => `pay(${this.ref})`;
}

class Cancel implements fc.AsyncCommand<Model, Real> {
  constructor(readonly ref: number) {}
  check = (m: Readonly<Model>) => m.orders.length > 0;
  async run(m: Model, r: Real): Promise<void> {
    const i = this.ref % m.orders.length;
    const order = m.orders[i];
    const expected = order.status === 'CANCELLED' ? 'SH002' : null;
    const out = await attempt(r.db, 'CALL cancel_order($1)', [r.orders[i]]);
    same(out.code, expected, `cancel(order ${i}, ${order.status}) outcome`);
    if (expected === null) {
      order.status = 'CANCELLED';
      for (const item of order.items) m.stock[item.p] += item.q; // the stock comes back
    }
    await checkState(m, r);
  }
  toString = () => `cancel(${this.ref})`;
}

const commands = [
  fc
    .array(fc.record({ p: fc.integer({ min: 0, max: 2 }), q: fc.integer({ min: 1, max: 3 }) }), {
      minLength: 1,
      maxLength: 3,
    })
    .map((items) => new PlaceOrder(items)),
  fc.nat().map((n) => new Pay(n)),
  fc.nat().map((n) => new Cancel(n)),
];

// One customer and three products made for the run, inside its transaction.
// `prepare` runs first: the mutation test uses it to break a procedure.
async function setup(db: Client, prepare?: string): Promise<Real> {
  if (prepare) await db.query(prepare);
  const customer = await db.query(
    `INSERT INTO customers (name, email, max_pending_orders) VALUES ('Model', 'model@example.com', $1) RETURNING id`,
    [LIMIT],
  );
  const products = await db.query(
    `INSERT INTO products (sku, name, price, stock)
     SELECT 'M-' || i, 'Model item ' || i, 10 * i, s
     FROM unnest($1::int[]) WITH ORDINALITY AS t(s, i)
     RETURNING id`,
    [INITIAL_STOCK],
  );
  return { db, customer: customer.rows[0].id, products: products.rows.map((p) => p.id).sort((a, b) => a - b), orders: [] };
}

function orderProperty(db: Client, prepare?: string) {
  return fc.asyncProperty(fc.commands(commands, { maxCommands: 20 }), async (cmds) => {
    await rolledBack(db, async () => {
      const real = await setup(db, prepare);
      await fc.asyncModelRun(() => ({ model: { stock: [...INITIAL_STOCK], orders: [] }, real }), cmds);
    });
  });
}

test('random sequences of orders, payments and cancellations always match the model', async ({ db }) => {
  // 100 sequences of up to 20 steps. On a failure, the report has the
  // shortest failing sequence and the seed: { seed: ..., path: ... } replays it.
  await fc.assert(orderProperty(db), { numRuns: 100 });
});

// A mutation test: break cancel_order on purpose (it forgets to return the
// stock) and check that the property notices, and that fast-check shrinks the
// failure to a short, readable sequence.
test('the model test catches a cancel_order that forgets to return the stock', async ({ db }) => {
  const broken = `
    CREATE OR REPLACE PROCEDURE cancel_order(p_order_id INTEGER)
    LANGUAGE plpgsql AS $$
    BEGIN
      UPDATE orders SET status = 'CANCELLED' WHERE id = p_order_id AND status <> 'CANCELLED';
      IF NOT FOUND THEN RAISE EXCEPTION 'already cancelled' USING ERRCODE = 'SH002'; END IF;
    END;
    $$`;

  const result = await fc.check(orderProperty(db, broken), { numRuns: 200, seed: 42 });

  expect(result.failed).toBe(true);
  // fast-check appends /*replayPath=...*/ to replay the exact run.
  const sequence = String(result.counterexample?.[0]).replace(/\s*\/\*.*\*\/$/, '');
  expect(sequence).toMatch(/^place\(p[01]x\d\),cancel\(\d+\)$/); // the smallest story that shows the bug
  expect(String(result.errorInstance)).toContain('stock: expected');
});
