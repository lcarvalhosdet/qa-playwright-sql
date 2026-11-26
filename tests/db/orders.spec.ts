import { test, expect } from './db.fixture';

// Queries and data-quality checks against the seed in db/init/03_seed.sql.
test.describe('orders queries', () => {
  test('every order has at least one item', async ({ db }) => {
    const { rows } = await db.query(`
      SELECT o.id
      FROM orders o
      WHERE NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id)`);
    expect(rows).toEqual([]);
  });

  test('LEFT JOIN finds the customers without orders', async ({ db }) => {
    const { rows } = await db.query(`
      SELECT c.name
      FROM customers c
      LEFT JOIN orders o ON o.customer_id = c.id
      WHERE o.id IS NULL`);
    expect(rows.map((row) => row.name)).toEqual(['Carla']);
  });

  test('GROUP BY with FILTER sums the revenue without the cancelled orders', async ({ db }) => {
    const { rows } = await db.query(`
      SELECT c.name,
             COUNT(DISTINCT o.id)::int                                   AS orders,
             SUM(oi.subtotal) FILTER (WHERE o.status <> 'CANCELLED')     AS revenue
      FROM customers c
      JOIN orders o       ON o.customer_id = c.id
      JOIN order_items oi ON oi.order_id   = o.id
      GROUP BY c.id, c.name
      HAVING COUNT(DISTINCT o.id) >= 2
      ORDER BY revenue DESC`);
    expect(rows).toEqual([
      { name: 'Bruno', orders: 2, revenue: '900.00' },
      { name: 'Ana', orders: 2, revenue: '300.00' },
    ]);
  });

  test('every payment matches the total of its order', async ({ db }) => {
    const { rows } = await db.query(`
      SELECT p.order_id, p.amount, SUM(oi.subtotal) AS total
      FROM payments p
      JOIN order_items oi ON oi.order_id = p.order_id
      GROUP BY p.order_id, p.amount
      HAVING p.amount <> SUM(oi.subtotal)`);
    expect(rows).toEqual([]);
  });
});
