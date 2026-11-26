import type { Client } from 'pg';
import { test, expect, rolledBack } from './db.fixture';

// The views and functions in db/init/07_advanced_queries.sql. Most tests read
// the seed; the date-based ones add a customer with orders on fixed dates in
// March 2024, inside a rolled-back transaction.

// Dan, with no city, and four orders. Times are in Recife (UTC-3).
//   2024-03-01 10:00  PAID       1 keyboard  150.00
//   2024-03-04 09:00  PAID       2 mice      100.00
//   2024-03-04 18:00  CANCELLED  1 monitor   900.00  (left out of revenue)
//   2024-03-10 23:30  PENDING    1 mouse      50.00  (already 03-11 in UTC)
async function addDan(db: Client): Promise<{ customerId: number; orderIds: number[] }> {
  const customer = await db.query(
    `INSERT INTO customers (name, email, city) VALUES ('Dan', 'dan@example.com', NULL) RETURNING id`,
  );
  const customerId: number = customer.rows[0].id;
  const orders = [
    { at: '2024-03-01 10:00-03', status: 'PAID', product: 1, quantity: 1, price: 150 },
    { at: '2024-03-04 09:00-03', status: 'PAID', product: 2, quantity: 2, price: 50 },
    { at: '2024-03-04 18:00-03', status: 'CANCELLED', product: 3, quantity: 1, price: 900 },
    { at: '2024-03-10 23:30-03', status: 'PENDING', product: 2, quantity: 1, price: 50 },
  ];
  const orderIds: number[] = [];
  for (const o of orders) {
    const { rows } = await db.query(
      'INSERT INTO orders (customer_id, status, created_at) VALUES ($1, $2, $3) RETURNING id',
      [customerId, o.status, o.at],
    );
    await db.query(
      'INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES ($1, $2, $3, $4)',
      [rows[0].id, o.product, o.quantity, o.price],
    );
    orderIds.push(rows[0].id);
  }
  return { customerId, orderIds };
}

test.describe('recursive CTEs', () => {
  test('category_tree walks the tree from the roots with depth and path', async ({ db }) => {
    const { rows } = await db.query('SELECT path, depth FROM category_tree ORDER BY path');
    expect(rows).toEqual([
      { path: 'Electronics', depth: 0 },
      { path: 'Electronics > Accessories', depth: 1 },
      { path: 'Electronics > Accessories > Cables', depth: 2 },
      { path: 'Electronics > Computers', depth: 1 },
      { path: 'Electronics > Computers > Monitors', depth: 2 },
      { path: 'Electronics > Computers > Peripherals', depth: 2 },
      { path: 'Electronics > Computers > Peripherals > Keyboards', depth: 3 },
      { path: 'Electronics > Computers > Peripherals > Mice', depth: 3 },
    ]);
  });

  test('category_ancestors walks up from a leaf to the root', async ({ db }) => {
    const { rows } = await db.query(
      `SELECT name, distance FROM category_ancestors((SELECT id FROM categories WHERE name = 'Keyboards'))`,
    );
    expect(rows).toEqual([
      { name: 'Peripherals', distance: 1 },
      { name: 'Computers', distance: 2 },
      { name: 'Electronics', distance: 3 },
    ]);
  });

  test('the CYCLE clause stops the walk when the data has a loop', async ({ db }) => {
    await rolledBack(db, async () => {
      // Electronics -> Keyboards closes a loop: Keyboards -> Peripherals ->
      // Computers -> Electronics -> Keyboards -> ... Without CYCLE the query
      // would never end; statement_timeout turns that into a failure.
      await db.query(`UPDATE categories SET parent_id = (SELECT id FROM categories WHERE name = 'Keyboards')
                      WHERE name = 'Electronics'`);
      await db.query(`SET LOCAL statement_timeout = '2s'`);

      const { rows } = await db.query(
        `SELECT name FROM category_ancestors((SELECT id FROM categories WHERE name = 'Keyboards'))`,
      );
      expect(rows.map((row) => row.name)).toEqual(['Peripherals', 'Computers', 'Electronics']);
    });
  });

  test('a category cannot be its own parent', async ({ db }) => {
    await rolledBack(db, async () => {
      await expect(db.query(`UPDATE categories SET parent_id = id WHERE name = 'Mice'`)).rejects.toMatchObject({
        code: '23514',
        constraint: 'categories_check',
      });
    });
  });

  test('category_sales adds every sale to its category and all the ones above it', async ({ db }) => {
    const { rows } = await db.query('SELECT path, products, units, revenue FROM category_sales ORDER BY path');
    expect(rows).toEqual([
      { path: 'Electronics', products: 4, units: 5, revenue: '1200.00' },
      { path: 'Electronics > Accessories', products: 1, units: 0, revenue: '0.00' },
      { path: 'Electronics > Accessories > Cables', products: 1, units: 0, revenue: '0.00' },
      { path: 'Electronics > Computers', products: 3, units: 5, revenue: '1200.00' },
      { path: 'Electronics > Computers > Monitors', products: 1, units: 1, revenue: '900.00' },
      { path: 'Electronics > Computers > Peripherals', products: 2, units: 4, revenue: '300.00' },
      { path: 'Electronics > Computers > Peripherals > Keyboards', products: 1, units: 1, revenue: '150.00' },
      { path: 'Electronics > Computers > Peripherals > Mice', products: 1, units: 3, revenue: '150.00' },
    ]);
  });

  test('the revenue of the root matches the total of product_sales', async ({ db }) => {
    // Oracle check: two independent paths to the same number.
    const { rows } = await db.query(`
      SELECT (SELECT revenue FROM category_sales WHERE depth = 0) AS from_tree,
             (SELECT SUM(revenue) FROM product_sales)             AS from_products`);
    expect(rows[0].from_tree).toBe(rows[0].from_products);
  });
});

test.describe('window functions', () => {
  test('customer_order_history numbers the orders and keeps a running total', async ({ db }) => {
    await rolledBack(db, async () => {
      const { customerId, orderIds } = await addDan(db);
      const { rows } = await db.query(
        `SELECT order_id, order_date::text, total, order_number, running_total,
                days_since_previous, share_of_customer
         FROM customer_order_history
         WHERE customer_id = $1
         ORDER BY order_number`,
        [customerId],
      );
      expect(rows).toEqual([
        { order_id: orderIds[0], order_date: '2024-03-01', total: '150.00', order_number: 1, running_total: '150.00', days_since_previous: null, share_of_customer: '0.50' },
        { order_id: orderIds[1], order_date: '2024-03-04', total: '100.00', order_number: 2, running_total: '250.00', days_since_previous: 3, share_of_customer: '0.33' },
        { order_id: orderIds[3], order_date: '2024-03-10', total: '50.00', order_number: 3, running_total: '300.00', days_since_previous: 6, share_of_customer: '0.17' },
      ]);
    });
  });

  test('dates follow the shop time zone, not UTC', async ({ db }) => {
    await rolledBack(db, async () => {
      const { orderIds } = await addDan(db);
      const { rows } = await db.query(
        `SELECT order_date::text AS recife, (created_at AT TIME ZONE 'UTC')::date::text AS utc
         FROM order_totals WHERE order_id = $1`,
        [orderIds[3]],
      );
      expect(rows[0]).toEqual({ recife: '2024-03-10', utc: '2024-03-11' });
    });
  });

  test('product_sales shows how ROW_NUMBER, RANK and DENSE_RANK treat a tie', async ({ db }) => {
    // The keyboard and the mouse both sold 150.00.
    const { rows } = await db.query(
      'SELECT sku, revenue, row_number, rank, dense_rank, pct_of_revenue FROM product_sales ORDER BY row_number',
    );
    expect(rows).toEqual([
      { sku: 'MN-01', revenue: '900.00', row_number: 1, rank: 1, dense_rank: 1, pct_of_revenue: '75.0' },
      { sku: 'KB-01', revenue: '150.00', row_number: 2, rank: 2, dense_rank: 2, pct_of_revenue: '12.5' },
      { sku: 'MS-01', revenue: '150.00', row_number: 3, rank: 2, dense_rank: 2, pct_of_revenue: '12.5' },
      { sku: 'CB-01', revenue: '0.00', row_number: 4, rank: 4, dense_rank: 3, pct_of_revenue: '0.0' },
    ]);
  });
});

test.describe('ROLLUP', () => {
  test('revenue_by_city returns each customer, a subtotal per city and the grand total', async ({ db }) => {
    const { rows } = await db.query('SELECT city, customer, revenue, level FROM revenue_by_city ORDER BY level, city, customer');
    expect(rows).toEqual([
      { city: 'Olinda', customer: 'Bruno', revenue: '900.00', level: 0 },
      { city: 'Recife', customer: 'Ana', revenue: '300.00', level: 0 },
      { city: 'Olinda', customer: 'All customers', revenue: '900.00', level: 1 },
      { city: 'Recife', customer: 'All customers', revenue: '300.00', level: 1 },
      { city: 'All cities', customer: 'All customers', revenue: '1200.00', level: 3 },
    ]);
  });

  test('GROUPING tells a customer without a city apart from a subtotal', async ({ db }) => {
    await rolledBack(db, async () => {
      await addDan(db); // city is NULL
      const { rows } = await db.query(`SELECT city, customer, revenue, level FROM revenue_by_city WHERE city IS NULL ORDER BY level`);
      // A real NULL city keeps NULL; only the rolled-up rows say "All cities".
      expect(rows).toEqual([
        { city: null, customer: 'Dan', revenue: '300.00', level: 0 },
        { city: null, customer: 'All customers', revenue: '300.00', level: 1 },
      ]);
    });
  });
});

test.describe('materialized view', () => {
  test('daily_sales shows new orders only after a REFRESH', async ({ db }) => {
    await rolledBack(db, async () => {
      await addDan(db);
      const march = `SELECT day::text, orders, revenue, avg_ticket, revenue_7d
                     FROM daily_sales WHERE day BETWEEN '2024-03-01' AND '2024-03-31' ORDER BY day`;

      expect((await db.query(march)).rows).toEqual([]);

      await db.query('REFRESH MATERIALIZED VIEW CONCURRENTLY daily_sales');

      // revenue_7d on 03-10 covers 03-04 to 03-10, so the sale of 03-01 is out.
      expect((await db.query(march)).rows).toEqual([
        { day: '2024-03-01', orders: 1, revenue: '150.00', avg_ticket: '150.00', revenue_7d: '150.00' },
        { day: '2024-03-04', orders: 1, revenue: '100.00', avg_ticket: '100.00', revenue_7d: '250.00' },
        { day: '2024-03-10', orders: 1, revenue: '50.00', avg_ticket: '50.00', revenue_7d: '150.00' },
      ]);
    });
  });

  test('REFRESH CONCURRENTLY depends on the unique index', async ({ db }) => {
    await rolledBack(db, async () => {
      await db.query('DROP INDEX daily_sales_day_key');
      await expect(db.query('REFRESH MATERIALIZED VIEW CONCURRENTLY daily_sales')).rejects.toMatchObject({
        code: '55000',
        hint: expect.stringContaining('unique index'),
      });
    });
  });
});

test.describe('UPSERT', () => {
  test('import_products inserts new SKUs, updates known ones and skips unchanged ones', async ({ db }) => {
    await rolledBack(db, async () => {
      const feed = [
        { sku: 'KB-01', name: 'Keyboard', price: 150, received: 0 }, // same as today: skipped
        { sku: 'MS-01', name: 'Mouse', price: 45 }, // new price
        { sku: 'MN-01', name: 'Monitor', price: 900, received: 2 }, // more stock
        { sku: 'HD-01', name: 'Headset', price: 80, received: 5 }, // new product
      ];
      const { rows: result } = await db.query('SELECT sku, action FROM import_products($1) ORDER BY sku', [
        JSON.stringify(feed),
      ]);
      expect(result).toEqual([
        { sku: 'HD-01', action: 'inserted' },
        { sku: 'MN-01', action: 'updated' },
        { sku: 'MS-01', action: 'updated' },
      ]);

      const { rows } = await db.query(
        `SELECT sku, price, stock FROM products WHERE sku IN ('KB-01', 'MS-01', 'MN-01', 'HD-01') ORDER BY sku`,
      );
      expect(rows).toEqual([
        { sku: 'HD-01', price: '80.00', stock: 5 },
        { sku: 'KB-01', price: '150.00', stock: 10 },
        { sku: 'MN-01', price: '900.00', stock: 5 },
        { sku: 'MS-01', price: '45.00', stock: 25 },
      ]);
    });
  });

  test('a SKU twice in one feed fails the whole import', async ({ db }) => {
    await rolledBack(db, async () => {
      const feed = [
        { sku: 'KB-01', name: 'Keyboard', price: 160 },
        { sku: 'KB-01', name: 'Keyboard', price: 170 },
      ];
      await expect(db.query('SELECT * FROM import_products($1)', [JSON.stringify(feed)])).rejects.toMatchObject({
        code: '21000', // cardinality_violation
        message: 'ON CONFLICT DO UPDATE command cannot affect row a second time',
      });
    });
  });

  test('one bad row stops the import, and the rows before it are not saved', async ({ db }) => {
    // No rolledBack: the import runs in autocommit and must save nothing.
    const feed = [
      { sku: 'NEW-01', name: 'Good row', price: 10, received: 1 },
      { sku: 'MS-01', name: 'Mouse', price: 50, received: -100 }, // stock would go negative
    ];
    await expect(db.query('SELECT * FROM import_products($1)', [JSON.stringify(feed)])).rejects.toMatchObject({
      code: '23514',
      constraint: 'products_stock_check',
    });
    const { rows } = await db.query(`SELECT COUNT(*)::int AS found FROM products WHERE sku = 'NEW-01'`);
    expect(rows[0].found).toBe(0);
  });
});
