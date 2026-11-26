import { Client } from 'pg';
import { DB_URL } from '../db/db.fixture';
import { test, expect } from './api.fixture';

// The pending-order limit (db/init/09_order_limits.sql) through the API.
// POST /orders runs as SERIALIZABLE and retries 40001 (api/src/retry.ts), so
// under any amount of concurrency every request ends as an order or as a
// business error, never as a 503, and the limit holds.

test('an order over the limit is 409 SH006', async ({ api, db, scratch }) => {
  const customer = await scratch.customer();
  await db.query('UPDATE customers SET max_pending_orders = 1 WHERE id = $1', [customer]);
  const product = await scratch.product(10);
  const order = () => api.post('/orders', { data: { customerId: customer, items: [{ productId: product, quantity: 1 }] } });

  expect((await order()).status()).toBe(201);
  const second = await order();

  expect(second.status()).toBe(409);
  expect(await second.json()).toEqual({
    code: 'SH006',
    error: `customer ${customer} already has 1 pending orders`,
    detail: 'the limit is 1',
    hint: 'Pay or cancel a pending order first.',
  });
});

test('twelve orders at once against a limit of 3: the limit holds and no request fails with 503', async ({
  api,
  db,
  scratch,
}) => {
  const limit = 3;
  const requests = 12;
  const customer = await scratch.customer();
  await db.query('UPDATE customers SET max_pending_orders = $2 WHERE id = $1', [customer, limit]);
  // One product per request, so the only thing the requests compete for is
  // the count of pending orders, not a row lock on the same product.
  const products: number[] = [];
  for (let i = 0; i < requests; i++) products.push(await scratch.product(5));

  // A barrier, so the requests overlap every time and not only when the
  // timing happens to line up (on a slow CI runner they once did not). The
  // test holds an exclusive lock on audit_log. Each request counts the
  // pending orders, inserts its own, and then waits at the audit trigger's
  // INSERT. Once more requests than the limit are waiting, all having counted
  // before any committed, the test lets them go.
  const barrier = new Client({ connectionString: DB_URL });
  await barrier.connect();
  let responses;
  try {
    await barrier.query('BEGIN');
    await barrier.query('LOCK TABLE audit_log IN EXCLUSIVE MODE');
    const barrierPid: number = (await barrier.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;

    const inFlight = Promise.all(
      products.map((productId) =>
        api.post('/orders', { data: { customerId: customer, items: [{ productId, quantity: 1 }] } }),
      ),
    );
    await expect
      .poll(
        async () =>
          (await db.query('SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [
            barrierPid,
          ])).rows[0].n,
        { message: 'requests waiting at the barrier', timeout: 10_000, intervals: [20] },
      )
      .toBeGreaterThan(limit);
    await barrier.query('COMMIT');
    responses = await inFlight;
  } finally {
    await barrier.end();
  }

  const statuses = responses.map((r) => r.status());
  expect(statuses.filter((s) => s === 201)).toHaveLength(limit);
  expect(statuses.filter((s) => s === 409)).toHaveLength(requests - limit);
  expect(statuses).not.toContain(503);

  const rejected = await Promise.all(responses.filter((r) => r.status() === 409).map((r) => r.json()));
  expect(new Set(rejected.map((body) => body.code))).toEqual(new Set(['SH006']));

  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM orders WHERE customer_id = $1 AND status = 'PENDING'`,
    [customer],
  );
  expect(rows[0].n).toBe(limit);

  // Proof that the requests collided and were retried. Every response, 201
  // or 409, says how many tries its transaction took.
  const attempts = responses.map((r) => Number(r.headers()['x-transaction-attempts']));
  test.info().annotations.push({ type: 'attempts per request', description: attempts.join(', ') });
  expect(attempts.every((n) => n >= 1)).toBe(true);
  expect(Math.max(...attempts)).toBeGreaterThan(1);
});
