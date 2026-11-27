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
  // The index on orders.customer_id from 02_indexes.sql was replaced in
  // 11_performance.sql by a composite index that starts with customer_id.
  test('the lookup by customer uses the index that starts with customer_id', async ({ db }) => {
    await rolledBack(db, async () => {
      await db.query(`INSERT INTO orders (customer_id, status) SELECT 3, 'PAID' FROM generate_series(1, 20000)`);
      await db.query('ANALYZE orders');

      const { rows } = await db.query(`EXPLAIN (FORMAT JSON) SELECT * FROM orders WHERE customer_id = 2`);
      const plan = JSON.stringify(rows[0]['QUERY PLAN']);
      expect(plan).toContain('"Index Name":"orders_customer_created_idx"');
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

// Catalog checks: they read the database's own description of itself, so
// they keep holding for tables and indexes added later.
test.describe('index hygiene', () => {
  // Without an index on its columns, a foreign key makes every DELETE or key
  // UPDATE on the parent scan the child table, and joins on it scan too.
  const foreignKeysWithoutIndex = `
    SELECT c.conrelid::REGCLASS::TEXT AS table_name, c.conname
    FROM pg_constraint c
    WHERE c.contype = 'f'
      AND c.connamespace = 'public'::REGNAMESPACE
      AND NOT EXISTS (
        SELECT 1
        FROM pg_index i
        WHERE i.indrelid = c.conrelid
          -- the index starts with the foreign key's columns, in order
          AND (SELECT array_agg(k ORDER BY ord)
               FROM unnest(i.indkey::INT2[]) WITH ORDINALITY AS u(k, ord)
               WHERE ord <= array_length(c.conkey, 1)) = c.conkey
      )
    ORDER BY 1, 2`;

  test('every foreign key has an index that starts with its columns', async ({ db }) => {
    expect((await db.query(foreignKeysWithoutIndex)).rows).toEqual([]);
  });

  // An index whose columns are the leading columns of another index on the
  // same table answers nothing the bigger one cannot, and costs a write on
  // every INSERT and UPDATE. Unique, partial and expression indexes are left
  // out: they do something the bigger one does not.
  const redundantIndexes = `
    SELECT a.indexrelid::REGCLASS::TEXT AS redundant, b.indexrelid::REGCLASS::TEXT AS covered_by
    FROM pg_index a
    JOIN pg_index b ON b.indrelid = a.indrelid AND b.indexrelid <> a.indexrelid
    JOIN pg_class ia ON ia.oid = a.indexrelid
    JOIN pg_class ib ON ib.oid = b.indexrelid
    WHERE ia.relnamespace = 'public'::REGNAMESPACE
      AND ia.relam = ib.relam
      AND NOT a.indisunique
      AND a.indpred IS NULL AND a.indexprs IS NULL
      AND b.indpred IS NULL AND b.indexprs IS NULL
      AND a.indnkeyatts <= b.indnkeyatts
      AND (a.indkey::INT2[])[0:a.indnkeyatts - 1] = (b.indkey::INT2[])[0:a.indnkeyatts - 1]
    ORDER BY 1`;

  test('no index is made redundant by another one', async ({ db }) => {
    expect((await db.query(redundantIndexes)).rows).toEqual([]);
  });

  test('the checks catch what they look for', async ({ db }) => {
    await rolledBack(db, async () => {
      // The single-column index that 11_performance.sql dropped.
      await db.query('CREATE INDEX orders_customer_id_idx ON orders (customer_id)');
      // A new foreign key without an index.
      await db.query('ALTER TABLE stock_alerts ADD COLUMN order_id INTEGER REFERENCES orders (id)');

      expect((await db.query(redundantIndexes)).rows).toEqual([
        { redundant: 'orders_customer_id_idx', covered_by: 'orders_customer_created_idx' },
      ]);
      expect((await db.query(foreignKeysWithoutIndex)).rows).toEqual([
        { table_name: 'stock_alerts', conname: 'stock_alerts_order_id_fkey' },
      ]);
    });
  });
});
