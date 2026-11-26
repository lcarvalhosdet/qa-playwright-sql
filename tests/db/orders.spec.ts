import { test, expect } from './db.fixture';

test.describe('orders database', () => {
  test('every order belongs to an existing customer', async ({ db }) => {
    const { rows } = await db.query(`
      SELECT o.id
      FROM orders o
      WHERE NOT EXISTS (SELECT 1 FROM customers c WHERE c.id = o.customer_id)`);
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

  test('GROUP BY and HAVING return the revenue of repeat customers', async ({ db }) => {
    const { rows } = await db.query(`
      SELECT c.name, COUNT(o.id)::int AS orders, SUM(o.amount) AS total
      FROM customers c
      JOIN orders o ON o.customer_id = c.id
      GROUP BY c.id, c.name
      HAVING COUNT(o.id) >= 2
      ORDER BY total DESC`);
    expect(rows).toEqual([
      { name: 'Ana', orders: 2, total: '150.00' },
      { name: 'Bruno', orders: 2, total: '50.00' },
    ]);
  });

  test('the foreign key rejects an order for a customer that does not exist', async ({ db }) => {
    await db.query('BEGIN');
    try {
      await expect(
        db.query(`INSERT INTO orders (id, customer_id, amount, status) VALUES (99, 999, 10, 'PAID')`),
      ).rejects.toThrow(/foreign key/);
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
