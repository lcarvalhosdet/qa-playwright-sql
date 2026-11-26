import { test, expect, rolledBack } from './db.fixture';

// The schema rules in db/init/01_schema.sql and 02_indexes.sql.
// Each write runs inside a rolled-back transaction, and each check asserts the
// SQLSTATE code and constraint name, not the error text, so it breaks only when
// the rule changes.
//   23503 foreign_key_violation   23505 unique_violation   23514 check_violation
//   22P02 invalid_text_representation   428C9 generated_always
test.describe('schema constraints', () => {
  test('CHECK keeps the stock from going negative', async ({ db }) => {
    await rolledBack(db, async () => {
      await expect(db.query(`UPDATE products SET stock = -1 WHERE sku = 'KB-01'`)).rejects.toMatchObject({
        code: '23514',
        constraint: 'products_stock_check',
      });
    });
  });

  test('CHECK accepts only the known payment methods', async ({ db }) => {
    await rolledBack(db, async () => {
      await expect(
        db.query(`INSERT INTO payments (order_id, amount, method) VALUES (2, 50, 'CASH')`),
      ).rejects.toMatchObject({ code: '23514', constraint: 'payments_method_check' });
    });
  });

  test('the ENUM rejects an unknown order status', async ({ db }) => {
    await rolledBack(db, async () => {
      await expect(
        db.query(`INSERT INTO orders (customer_id, status) VALUES (1, 'SHIPPING')`),
      ).rejects.toMatchObject({ code: '22P02' });
    });
  });

  test('the expression index makes the email unique ignoring case', async ({ db }) => {
    await rolledBack(db, async () => {
      await expect(
        db.query(`INSERT INTO customers (name, email) VALUES ('Ana Clone', 'ANA@Example.com')`),
      ).rejects.toMatchObject({ code: '23505', constraint: 'customers_email_lower_key' });
    });
  });

  test('UNIQUE allows one payment per order', async ({ db }) => {
    await rolledBack(db, async () => {
      await expect(
        db.query(`INSERT INTO payments (order_id, amount, method) VALUES (1, 250, 'CARD')`),
      ).rejects.toMatchObject({ code: '23505', constraint: 'payments_order_id_key' });
    });
  });

  test('the database computes the subtotal', async ({ db }) => {
    const { rows } = await db.query(`
      SELECT product_id, quantity, unit_price, subtotal
      FROM order_items
      WHERE order_id = 1
      ORDER BY product_id`);
    expect(rows).toEqual([
      { product_id: 1, quantity: 1, unit_price: '150.00', subtotal: '150.00' },
      { product_id: 2, quantity: 2, unit_price: '50.00', subtotal: '100.00' },
    ]);
  });

  test('the generated subtotal cannot be written', async ({ db }) => {
    await rolledBack(db, async () => {
      await expect(
        db.query(`UPDATE order_items SET subtotal = 1 WHERE order_id = 1 AND product_id = 1`),
      ).rejects.toMatchObject({ code: '428C9' });
    });
  });

  test('the identity column rejects an id chosen by the client', async ({ db }) => {
    await rolledBack(db, async () => {
      await expect(
        db.query(`INSERT INTO customers (id, name, email) VALUES (99, 'Dan', 'dan@example.com')`),
      ).rejects.toMatchObject({ code: '428C9' });
    });
  });

  test('the foreign key rejects an order for a customer that does not exist', async ({ db }) => {
    await rolledBack(db, async () => {
      await expect(db.query(`INSERT INTO orders (customer_id) VALUES (999)`)).rejects.toMatchObject({
        code: '23503',
        constraint: 'orders_customer_id_fkey',
      });
    });
  });

  test('ON DELETE RESTRICT keeps a customer that has orders', async ({ db }) => {
    await rolledBack(db, async () => {
      await expect(db.query(`DELETE FROM customers WHERE id = 1`)).rejects.toMatchObject({
        code: '23503',
        constraint: 'orders_customer_id_fkey',
      });
    });
  });

  test('ON DELETE CASCADE removes the items with their order', async ({ db }) => {
    await rolledBack(db, async () => {
      await db.query(`DELETE FROM orders WHERE id = 2`);
      const { rows } = await db.query(`SELECT COUNT(*)::int AS items FROM order_items WHERE order_id = 2`);
      expect(rows[0].items).toBe(0);
    });
  });
});

test.describe('indexes', () => {
  // With 4 orders the planner reads the whole table, because that is cheaper
  // than using an index. The test adds 20,000 orders, refreshes the statistics
  // with ANALYZE and reads the plan from EXPLAIN. Everything is rolled back.
  test('the lookup by customer uses the foreign key index', async ({ db }) => {
    await rolledBack(db, async () => {
      await db.query(`INSERT INTO orders (customer_id, status) SELECT 3, 'PAID' FROM generate_series(1, 20000)`);
      await db.query('ANALYZE orders');

      const { rows } = await db.query(`EXPLAIN (FORMAT JSON) SELECT * FROM orders WHERE customer_id = 2`);
      const plan = JSON.stringify(rows[0]['QUERY PLAN']);
      expect(plan).toContain('"Index Name":"orders_customer_id_idx"');
    });
  });

  test('the partial index serves only the PENDING orders', async ({ db }) => {
    await rolledBack(db, async () => {
      await db.query(`INSERT INTO orders (customer_id, status) SELECT 3, 'PAID' FROM generate_series(1, 20000)`);
      await db.query('ANALYZE orders');

      const pending = await db.query(
        `EXPLAIN (FORMAT JSON) SELECT id FROM orders WHERE status = 'PENDING' ORDER BY created_at`,
      );
      expect(JSON.stringify(pending.rows[0]['QUERY PLAN'])).toContain('orders_pending_created_at_idx');

      const paid = await db.query(
        `EXPLAIN (FORMAT JSON) SELECT id FROM orders WHERE status = 'PAID' ORDER BY created_at`,
      );
      expect(JSON.stringify(paid.rows[0]['QUERY PLAN'])).not.toContain('orders_pending_created_at_idx');
    });
  });
});
