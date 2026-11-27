import { test, expect, explain } from './perf.fixture';

// The queries the shop runs most, on the volume in shop_perf. Each test checks
// the plan (which index, no Sort, no Seq Scan) and a budget of buffers, the
// 8 kB pages the query reads. Buffers measure work without depending on the
// machine's speed, so a budget fails when a query starts doing far more work,
// for example after an index is dropped or a query stops matching it, and
// never because the CI runner was slow.
//
// Budgets are about twice what each query reads today: room for small changes
// in the data, far below what a full scan costs (thousands of pages).

test.describe.configure({ mode: 'serial' }); // one test drops an index inside a transaction

test('the volume is loaded', async ({ perf }) => {
  const { rows } = await perf.query(`
    SELECT (SELECT COUNT(*) FROM customers)::int   AS customers,
           (SELECT COUNT(*) FROM orders)::int      AS orders,
           (SELECT COUNT(*) FROM order_items)::int AS items`);
  expect(rows[0].customers).toBeGreaterThan(20_000);
  expect(rows[0].orders).toBeGreaterThan(205_000);
  expect(rows[0].items).toBeGreaterThan(500_000);
});

test.describe('hot queries', () => {
  test("a customer's latest orders: Index Only Scan, already sorted", async ({ perf }) => {
    const { rows } = await perf.query(`SELECT id FROM customers WHERE email = 'wholesale@perf.example.com'`);
    const plan = await explain(
      perf,
      'SELECT id, status, created_at FROM orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 10',
      [rows[0].id],
    );

    expect(plan.indexes).toEqual(['orders_customer_created_idx']);
    expect(plan.nodeTypes).toContain('Index Only Scan');
    expect(plan.nodeTypes).not.toContain('Sort'); // the index returns them newest first
    expect(plan.nodes.find((n) => n['Node Type'] === 'Index Only Scan')?.['Heap Fetches']).toBe(0);
    expect(plan.buffers).toBeLessThanOrEqual(10); // 5,000 orders, 10 read
  });

  test('a customer by email in any case: the expression index', async ({ perf }) => {
    const plan = await explain(perf, 'SELECT id FROM customers WHERE lower(email) = lower($1)', [
      'Customer777@PERF.example.com',
    ]);
    expect(plan.indexes).toEqual(['customers_email_lower_key']);
    expect(plan.buffers).toBeLessThanOrEqual(10);
  });

  test('the oldest pending orders: the partial index, already sorted', async ({ perf }) => {
    const plan = await explain(
      perf,
      `SELECT id FROM orders WHERE status = 'PENDING' ORDER BY created_at LIMIT 50`,
    );
    expect(plan.indexes).toEqual(['orders_pending_created_at_idx']);
    expect(plan.nodeTypes).not.toContain('Sort');
    expect(plan.buffers).toBeLessThanOrEqual(110);
  });

  test("one order with its items, as GET /orders/:id reads it", async ({ perf }) => {
    const plan = await explain(perf, 'SELECT * FROM order_totals WHERE order_id = $1', [54321]);
    expect(plan.indexes).toEqual(expect.arrayContaining(['orders_pkey', 'customers_pkey']));
    expect(plan.nodeTypes).not.toContain('Seq Scan');
    expect(plan.buffers).toBeLessThanOrEqual(30);
  });

  test('the order lines of a product: the foreign key index', async ({ perf }) => {
    const plan = await explain(perf, 'SELECT order_id, quantity FROM order_items WHERE product_id = $1', [1000]);
    expect(plan.indexes).toEqual(['order_items_product_id_idx']);
    expect(plan.nodeTypes).not.toContain('Seq Scan');
    expect(plan.buffers).toBeLessThanOrEqual(600); // about 250 rows on as many pages
  });

  test('the budget catches a regression: without the index the same query reads thousands of pages', async ({
    perf,
  }) => {
    const { rows } = await perf.query(`SELECT id FROM customers WHERE email = 'wholesale@perf.example.com'`);
    const sql = 'SELECT id, status, created_at FROM orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 10';
    await perf.query('BEGIN');
    try {
      await perf.query('DROP INDEX orders_customer_created_idx'); // undone by the ROLLBACK
      const plan = await explain(perf, sql, [rows[0].id]);
      expect(plan.indexes).not.toContain('orders_customer_created_idx');
      expect(plan.nodeTypes).toContain('Sort');
      expect(plan.buffers).toBeGreaterThan(1_000);
    } finally {
      await perf.query('ROLLBACK');
    }
  });
});

test.describe('partitioned audit_log', () => {
  // The volume covers the 12 months before the run, so the month is computed,
  // not written down: five months ago, always inside the data.
  let month: { start: string; end: string; day: string; nextDay: string; partition: string };

  test.beforeAll(async ({ perf }) => {
    const { rows } = await perf.query(`
      SELECT m::DATE::TEXT                                 AS start,
             (m + INTERVAL '1 month')::DATE::TEXT          AS end,
             (m + INTERVAL '9 days')::DATE::TEXT           AS day,
             (m + INTERVAL '10 days')::DATE::TEXT          AS "nextDay",
             'audit_log_' || to_char(m, 'YYYY_MM')         AS partition
      FROM date_trunc('month', now() - INTERVAL '5 months') AS m`);
    month = rows[0];
  });

  test('a query for one month reads only that month', async ({ perf }) => {
    const plan = await explain(
      perf,
      `SELECT COUNT(*) FROM audit_log WHERE changed_at >= '${month.start}' AND changed_at < '${month.end}'`,
    );
    expect(new Set(plan.relations)).toEqual(new Set([month.partition]));
  });

  test('a query without changed_at has to visit every partition', async ({ perf }) => {
    const { rows } = await perf.query(
      `SELECT COUNT(*)::int AS n FROM pg_inherits WHERE inhparent = 'audit_log'::REGCLASS`,
    );
    const plan = await explain(perf, `SELECT * FROM audit_log WHERE table_name = 'orders' AND row_id = $1`, [12345]);
    // Pruning needs the partition key in the WHERE; the history of one row
    // touches all of them, through each one's index.
    expect(new Set(plan.relations).size).toBe(rows[0].n);
  });

  test('BRIN: a fraction of the size of a B-tree on the same column, and used for date ranges', async ({ perf }) => {
    await perf.query('BEGIN');
    try {
      await perf.query(`CREATE INDEX month_btree ON ${month.partition} (changed_at)`); // for comparison only
      const { rows } = await perf.query(
        `SELECT pg_relation_size($1::REGCLASS) AS brin, pg_relation_size('month_btree') AS btree`,
        [`${month.partition}_changed_at_idx`],
      );
      expect(Number(rows[0].brin) * 10).toBeLessThan(Number(rows[0].btree));
    } finally {
      await perf.query('ROLLBACK');
    }

    const plan = await explain(
      perf,
      `SELECT * FROM audit_log WHERE changed_at >= '${month.day}' AND changed_at < '${month.nextDay}'`,
    );
    expect(plan.indexes).toEqual([`${month.partition}_changed_at_idx`]);
    expect(plan.nodeTypes).toContain('Bitmap Index Scan');
  });
});

test('pg_stat_statements groups the same query with different values into one entry', async ({ perf }) => {
  await perf.query('SELECT pg_stat_statements_reset()');
  for (const n of [11, 22, 33, 44, 55]) {
    // Literal values, not parameters: pg_stat_statements still sees one query.
    await perf.query(`SELECT id FROM customers WHERE lower(email) = 'customer${n}@perf.example.com'`);
  }

  const { rows } = await perf.query(`
    SELECT query, calls::int, shared_blks_hit + shared_blks_read AS buffers
    FROM pg_stat_statements
    WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND query LIKE 'SELECT id FROM customers WHERE lower(email) = %'`);
  expect(rows).toHaveLength(1);
  expect(rows[0].query).toBe('SELECT id FROM customers WHERE lower(email) = $1');
  expect(rows[0].calls).toBe(5);
});
