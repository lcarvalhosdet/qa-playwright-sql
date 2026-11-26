import { test, expect, rolledBack } from './db.fixture';

// The functions in db/init/04_functions.sql.
//   P0002 no_data_found   22023 invalid_parameter_value
//   42P17 invalid_object_definition   2BP01 dependent_objects_still_exist
test.describe('order_total', () => {
  test('matches the total computed with GROUP BY for every order', async ({ db }) => {
    // Oracle test: the function must agree with an independent query.
    const { rows } = await db.query(`
      SELECT o.id, order_total(o.id) AS from_function, SUM(oi.subtotal) AS from_query
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      GROUP BY o.id
      ORDER BY o.id`);
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row.from_function).toBe(row.from_query);
    expect(rows.map((row) => row.from_function)).toEqual(['250.00', '50.00', '900.00', '150.00']);
  });

  test('returns 0.00 for an order without items', async ({ db }) => {
    await rolledBack(db, async () => {
      // Two statements on purpose. In a single one,
      //   WITH n AS (INSERT ... RETURNING id) SELECT order_total(id) FROM n
      // the function would raise "order 5 does not exist": every part of a
      // statement reads the same snapshot, taken before the INSERT ran.
      const inserted = await db.query(`INSERT INTO orders (customer_id) VALUES (3) RETURNING id`);
      const { rows } = await db.query('SELECT order_total($1) AS total', [inserted.rows[0].id]);
      expect(rows[0].total).toBe('0.00');
    });
  });

  test('raises no_data_found for an order that does not exist', async ({ db }) => {
    await expect(db.query('SELECT order_total(999)')).rejects.toMatchObject({
      code: 'P0002',
      message: 'order 999 does not exist',
    });
  });

  test('is STABLE, so it cannot be used in an index', async ({ db }) => {
    await rolledBack(db, async () => {
      await expect(db.query('CREATE INDEX ON orders (order_total(id))')).rejects.toMatchObject({
        code: '42P17',
      });
    });
  });
});

test.describe('apply_discount', () => {
  const cases = [
    { amount: '250.00', percent: '10', expected: '225.00' },
    { amount: '9.99', percent: '15', expected: '8.49' }, // 8.4915 rounded
    { amount: '100.00', percent: '0', expected: '100.00' },
    { amount: '100.00', percent: '100', expected: '0.00' },
  ];
  for (const { amount, percent, expected } of cases) {
    test(`${percent}% off ${amount} is ${expected}`, async ({ db }) => {
      const { rows } = await db.query('SELECT apply_discount($1, $2) AS result', [amount, percent]);
      expect(rows[0].result).toBe(expected);
    });
  }

  test('rejects a percentage outside 0 to 100 with a hint', async ({ db }) => {
    for (const percent of ['-1', '100.01']) {
      await expect(db.query('SELECT apply_discount(10, $1)', [percent])).rejects.toMatchObject({
        code: '22023',
        hint: 'Pass the percentage as a number, e.g. 15 for 15%.',
      });
    }
  });

  test('is STRICT, so a NULL argument returns NULL', async ({ db }) => {
    const { rows } = await db.query('SELECT apply_discount(NULL, 10) AS a, apply_discount(10, NULL) AS b');
    expect(rows[0]).toEqual({ a: null, b: null });
  });
});

test.describe('customer_summary', () => {
  test('returns one row per customer with LATERAL, including a customer without orders', async ({ db }) => {
    const { rows } = await db.query(`
      SELECT c.name, s.*
      FROM customers c
      CROSS JOIN LATERAL customer_summary(c.id) s
      ORDER BY s.revenue DESC`);
    expect(rows).toEqual([
      { name: 'Bruno', orders: 2, cancelled: 1, revenue: '900.00', avg_ticket: '900.00' },
      { name: 'Ana', orders: 2, cancelled: 0, revenue: '300.00', avg_ticket: '150.00' },
      { name: 'Carla', orders: 0, cancelled: 0, revenue: '0.00', avg_ticket: null },
    ]);
  });

  test('is a SQL function, so the planner inlines it into the calling query', async ({ db }) => {
    // A PL/pgSQL function would show up as one opaque "Function Scan" node.
    // Inlined, its own tables appear in the caller's plan instead. Whether
    // those tables are read by index or Seq Scan depends on the statistics,
    // so the test does not assert on that.
    const { rows } = await db.query('EXPLAIN (FORMAT JSON) SELECT * FROM customer_summary(1)');
    const plan = JSON.stringify(rows[0]['QUERY PLAN']);
    expect(plan).not.toContain('Function Scan');
    expect(plan).toContain('"Relation Name":"orders"');
    expect(plan).toContain('"Relation Name":"order_items"');
  });
});

test.describe('can_fulfill', () => {
  const cases = [
    { product: 1, quantity: 10, expected: true, why: 'exactly the stock of the keyboard' },
    { product: 1, quantity: 11, expected: false, why: 'one more than the stock' },
    { product: 4, quantity: 1, expected: false, why: 'the cable is out of stock' },
    { product: 999, quantity: 1, expected: false, why: 'the product does not exist' },
  ];
  for (const { product, quantity, expected, why } of cases) {
    test(`product ${product} x ${quantity} is ${expected}: ${why}`, async ({ db }) => {
      const { rows } = await db.query('SELECT can_fulfill($1, $2) AS ok', [product, quantity]);
      expect(rows[0].ok).toBe(expected);
    });
  }

  test('its BEGIN ATOMIC body blocks dropping the column it reads', async ({ db }) => {
    await rolledBack(db, async () => {
      await expect(db.query('ALTER TABLE products DROP COLUMN stock')).rejects.toMatchObject({
        code: '2BP01',
        detail: expect.stringContaining('function can_fulfill(integer,integer) depends on column stock'),
      });
    });
  });
});
