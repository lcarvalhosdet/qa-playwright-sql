import type { Client } from 'pg';
import { test, expect, rolledBack } from './db.fixture';

// The triggers in db/init/06_triggers.sql.
//   SH002 invalid status change   SH003 order without items   SH004 append-only

// The audit rows written by the current transaction, oldest first. Filtering by
// transaction keeps out rows that committed tests left in the append-only log.
async function auditOfThisTransaction(db: Client) {
  const { rows } = await db.query(`
    SELECT table_name, operation, row_id, changed_fields, old_data, new_data, changed_by
    FROM audit_log
    WHERE transaction_id = txid_current()
    ORDER BY id`);
  return rows;
}

async function placeOrder(db: Client, customerId: number, items: object[]): Promise<number> {
  const { rows } = await db.query('CALL place_order($1, $2)', [customerId, JSON.stringify(items)]);
  return rows[0].p_order_id;
}

test.describe('updated_at', () => {
  test('a BEFORE UPDATE trigger sets it to the transaction time', async ({ db }) => {
    await rolledBack(db, async () => {
      const { rows } = await db.query(`
        UPDATE products SET price = 160 WHERE id = 1
        RETURNING updated_at = now() AS is_now`);
      expect(rows[0].is_now).toBe(true);
    });
  });

  test('an update that changes nothing keeps it, thanks to the WHEN clause', async ({ db }) => {
    await rolledBack(db, async () => {
      const { rows } = await db.query(`
        UPDATE products SET price = price WHERE id = 1
        RETURNING updated_at = now() AS is_now`);
      expect(rows[0].is_now).toBe(false);
      expect(await auditOfThisTransaction(db)).toEqual([]);
    });
  });
});

test.describe('status transitions', () => {
  const allowed = [
    { order: 2, from: 'PENDING', to: 'PAID' },
    { order: 2, from: 'PENDING', to: 'CANCELLED' },
    { order: 1, from: 'PAID', to: 'SHIPPED' },
    { order: 1, from: 'PAID', to: 'CANCELLED' },
  ];
  for (const { order, from, to } of allowed) {
    test(`allows ${from} -> ${to}`, async ({ db }) => {
      await rolledBack(db, async () => {
        const { rows } = await db.query('UPDATE orders SET status = $2 WHERE id = $1 RETURNING status', [order, to]);
        expect(rows[0].status).toBe(to);
      });
    });
  }

  const rejected = [
    { order: 2, from: 'PENDING', to: 'SHIPPED' },
    { order: 1, from: 'PAID', to: 'PENDING' },
    { order: 4, from: 'CANCELLED', to: 'PAID' },
    { order: 4, from: 'CANCELLED', to: 'PENDING' },
  ];
  for (const { order, from, to } of rejected) {
    test(`rejects ${from} -> ${to} even in a plain UPDATE`, async ({ db }) => {
      await rolledBack(db, async () => {
        await expect(db.query('UPDATE orders SET status = $2 WHERE id = $1', [order, to])).rejects.toMatchObject({
          code: 'SH002',
          message: `order ${order} cannot go from ${from} to ${to}`,
        });
      });
    });
  }

  test('reads the rules from a table, so a new rule needs no code change', async ({ db }) => {
    await rolledBack(db, async () => {
      await db.query(`INSERT INTO order_status_transitions VALUES ('CANCELLED', 'PENDING')`);
      const { rows } = await db.query(`UPDATE orders SET status = 'PENDING' WHERE id = 4 RETURNING status`);
      expect(rows[0].status).toBe('PENDING');
    });
  });
});

test.describe('audit log', () => {
  test('records an UPDATE with the old and new values and the changed fields', async ({ db }) => {
    await rolledBack(db, async () => {
      await db.query('UPDATE products SET price = 200, stock = 9 WHERE id = 1');

      const [entry] = await auditOfThisTransaction(db);
      expect(entry).toMatchObject({
        table_name: 'products',
        operation: 'UPDATE',
        row_id: 1,
        changed_fields: ['price', 'stock'],
        changed_by: 'qa',
        old_data: expect.objectContaining({ price: 150, stock: 10 }),
        new_data: expect.objectContaining({ price: 200, stock: 9 }),
      });
    });
  });

  test('records an INSERT with only the new row and a DELETE with only the old one', async ({ db }) => {
    await rolledBack(db, async () => {
      const { rows } = await db.query(
        `INSERT INTO products (sku, name, price) VALUES ('TMP-01', 'Temporary', 5) RETURNING id`,
      );
      const id = rows[0].id;
      await db.query('DELETE FROM products WHERE id = $1', [id]);

      const entries = await auditOfThisTransaction(db);
      expect(entries.map((e) => [e.operation, e.row_id, e.old_data?.sku ?? null, e.new_data?.sku ?? null])).toEqual([
        ['INSERT', id, null, 'TMP-01'],
        ['DELETE', id, 'TMP-01', null],
      ]);
    });
  });

  test('records every table a procedure touches, in one transaction', async ({ db }) => {
    await rolledBack(db, async () => {
      const orderId = await placeOrder(db, 1, [
        { product_id: 1, quantity: 2 },
        { product_id: 2, quantity: 1 },
      ]);
      await db.query(`CALL pay_order($1, 'PIX')`, [orderId]);

      const entries = await auditOfThisTransaction(db);
      expect(entries.map((e) => [e.table_name, e.operation, e.row_id, e.changed_fields])).toEqual([
        ['orders', 'INSERT', orderId, null],
        ['products', 'UPDATE', 1, ['stock']],
        ['products', 'UPDATE', 2, ['stock']],
        ['payments', 'INSERT', expect.any(Number), null],
        ['orders', 'UPDATE', orderId, ['status']],
      ]);
    });
  });

  test('is append-only: UPDATE, DELETE and TRUNCATE are refused', async ({ db }) => {
    for (const statement of ['UPDATE audit_log SET operation = $$X$$', 'DELETE FROM audit_log', 'TRUNCATE audit_log']) {
      const operation = statement.split(' ')[0];
      await rolledBack(db, async () => {
        // Make sure there is a row, or the row triggers would have nothing to fire on.
        await db.query('UPDATE products SET price = price + 1 WHERE id = 1');
        await expect(db.query(statement)).rejects.toMatchObject({
          code: 'SH004',
          message: `audit_log is append-only: ${operation} is not allowed`,
        });
      });
    }
  });
});

test.describe('stock alerts', () => {
  test('one statement over many rows alerts only for the products that crossed the reorder level', async ({ db }) => {
    await rolledBack(db, async () => {
      // Keyboard 10 -> 9, mouse 25 -> 24, monitor 3 -> 2 (reorder level 2), cable stays 0.
      await db.query('UPDATE products SET stock = stock - 1 WHERE stock > 0');

      const { rows } = await db.query('SELECT product_id, stock, reorder_level FROM stock_alerts');
      expect(rows).toEqual([{ product_id: 3, stock: 2, reorder_level: 2 }]);
    });
  });

  test('a product already below the level does not alert again', async ({ db }) => {
    await rolledBack(db, async () => {
      await db.query('UPDATE products SET stock = 2 WHERE id = 3'); // crosses: alert
      await db.query('UPDATE products SET stock = 1 WHERE id = 3'); // already below: no alert
      await db.query('UPDATE products SET stock = 0 WHERE id = 3'); // already below: no alert

      const { rows } = await db.query('SELECT COUNT(*)::int AS alerts FROM stock_alerts WHERE product_id = 3');
      expect(rows[0].alerts).toBe(1);
    });
  });

  test('placing an order that takes the stock down raises an alert', async ({ db }) => {
    await rolledBack(db, async () => {
      await placeOrder(db, 2, [{ product_id: 3, quantity: 1 }]); // monitor 3 -> 2

      const { rows } = await db.query('SELECT product_id, stock FROM stock_alerts');
      expect(rows).toEqual([{ product_id: 3, stock: 2 }]);
    });
  });
});

test.describe('orders must have items (deferred constraint trigger)', () => {
  test('waits until the end of the transaction, then rejects an order without items', async ({ db }) => {
    await rolledBack(db, async () => {
      // The INSERT itself succeeds: the check is deferred.
      const { rows } = await db.query('INSERT INTO orders (customer_id) VALUES (3) RETURNING id');
      // IMMEDIATE runs the pending checks now, as COMMIT would.
      await expect(db.query('SET CONSTRAINTS orders_must_have_items IMMEDIATE')).rejects.toMatchObject({
        code: 'SH003',
        message: `order ${rows[0].id} has no items`,
      });
    });
  });

  test('accepts an order whose items arrive later in the same transaction', async ({ db }) => {
    await rolledBack(db, async () => {
      const { rows } = await db.query('INSERT INTO orders (customer_id) VALUES (3) RETURNING id');
      await db.query(
        'INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES ($1, 1, 1, 150)',
        [rows[0].id],
      );
      await expect(db.query('SET CONSTRAINTS orders_must_have_items IMMEDIATE')).resolves.toBeDefined();
    });
  });

  // No rolledBack: the INSERT commits on its own, and the COMMIT is what fails.
  test('fails the COMMIT of an order without items, and nothing is saved', async ({ db }) => {
    const before = await db.query('SELECT COUNT(*)::int AS orders FROM orders');
    await expect(db.query('INSERT INTO orders (customer_id) VALUES (3)')).rejects.toMatchObject({ code: 'SH003' });
    const after = await db.query('SELECT COUNT(*)::int AS orders FROM orders');
    expect(after.rows[0].orders).toBe(before.rows[0].orders);
  });
});
