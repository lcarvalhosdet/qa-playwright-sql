import type { Client } from 'pg';
import { test, expect, rolledBack } from './db.fixture';

// Roles, grants, SECURITY DEFINER and row-level security from
// db/init/10_security.sql. The worker connects as qa, a superuser; each test
// switches to another role with SET LOCAL ROLE inside a rolled-back
// transaction, so the switch ends with the test.
//   42501 insufficient_privilege

type Role = 'shop_api' | 'shop_reporting' | 'shop_customer';

// Runs fn as `role`, and as customer `customerId` when given (what the
// customer portal would set for each request).
async function as<T>(db: Client, role: Role, fn: () => Promise<T>, customerId?: number): Promise<T> {
  return rolledBack(db, async () => {
    await db.query(`SET LOCAL ROLE ${role}`);
    if (customerId !== undefined) {
      await db.query(`SELECT set_config('app.customer_id', $1, true)`, [String(customerId)]);
    }
    return fn();
  });
}

const denied = { code: '42501' };

test.describe('shop_api: writes only through the procedures', () => {
  test('can place an order, and the stock changes', async ({ db }) => {
    await as(db, 'shop_api', async () => {
      await db.query(`CALL place_order(1, '[{"product_id": 2, "quantity": 1}]')`);
      const { rows } = await db.query('SELECT stock FROM products WHERE id = 2');
      expect(rows[0].stock).toBe(24);
    });
  });

  const directWrites = [
    `UPDATE products SET stock = 0 WHERE id = 1`,
    `UPDATE orders SET status = 'PAID' WHERE id = 2`,
    `INSERT INTO orders (customer_id) VALUES (1)`,
    `DELETE FROM payments WHERE order_id = 1`,
    `INSERT INTO payments (order_id, amount, method) VALUES (2, 50, 'PIX')`,
  ];
  for (const sql of directWrites) {
    test(`is refused a direct write: ${sql.split(' (')[0].split(' WHERE')[0]}`, async ({ db }) => {
      await as(db, 'shop_api', async () => {
        await expect(db.query(sql)).rejects.toMatchObject(denied);
      });
    });
  }

  test('cannot forge or even read the audit log', async ({ db }) => {
    await as(db, 'shop_api', async () => {
      await expect(
        db.query(`INSERT INTO audit_log (table_name, operation, row_id) VALUES ('orders', 'DELETE', 1)`),
      ).rejects.toMatchObject(denied);
    });
    await as(db, 'shop_api', async () => {
      await expect(db.query('SELECT * FROM audit_log')).rejects.toMatchObject(denied);
    });
  });

  test('cannot run the operators batch job', async ({ db }) => {
    await as(db, 'shop_api', async () => {
      await expect(db.query(`CALL expire_pending_orders(now())`)).rejects.toMatchObject(denied);
    });
  });

  test('its changes are audited under its own name, not the owner of the procedure', async ({ db }) => {
    await rolledBack(db, async () => {
      await db.query('SET LOCAL ROLE shop_api');
      await db.query(`CALL place_order(1, '[{"product_id": 2, "quantity": 1}]')`);
      await db.query('RESET ROLE'); // back to qa, to read the log
      const { rows } = await db.query(
        'SELECT DISTINCT changed_by FROM audit_log WHERE transaction_id = txid_current()',
      );
      expect(rows).toEqual([{ changed_by: 'shop_api' }]);
    });
  });
});

test.describe('routines', () => {
  test('PUBLIC cannot execute them: a role needs an explicit grant', async ({ db }) => {
    const { rows } = await db.query(`
      SELECT p.proname
      FROM pg_proc p
      WHERE p.pronamespace = 'public'::REGNAMESPACE
        AND has_function_privilege('public', p.oid, 'EXECUTE')
      ORDER BY p.proname`);
    expect(rows).toEqual([]);
  });

  test('a role without the grant cannot call a procedure', async ({ db }) => {
    await as(db, 'shop_reporting', async () => {
      await expect(db.query(`CALL place_order(1, '[]')`)).rejects.toMatchObject(denied);
    });
  });

  // A catalog check: it keeps holding for routines added later.
  test('every SECURITY DEFINER routine pins its search_path', async ({ db }) => {
    const { rows } = await db.query(`
      SELECT p.proname, p.proconfig
      FROM pg_proc p
      WHERE p.pronamespace = 'public'::REGNAMESPACE
        AND p.prosecdef
      ORDER BY p.proname`);
    expect(rows.map((r) => r.proname)).toEqual([
      'audit_row',
      'cancel_order',
      'pay_order',
      'place_order',
      'update_product_price',
    ]);
    for (const row of rows) {
      expect(row.proconfig, row.proname).toContain('search_path=public, pg_temp');
    }
  });
});

test.describe('shop_reporting: the report views only', () => {
  test('reads the reports', async ({ db }) => {
    await as(db, 'shop_reporting', async () => {
      const { rows } = await db.query('SELECT sku FROM product_sales ORDER BY row_number LIMIT 1');
      expect(rows).toEqual([{ sku: 'MN-01' }]);
    });
  });

  for (const table of ['customers', 'orders', 'payments', 'audit_log']) {
    test(`cannot read ${table}`, async ({ db }) => {
      await as(db, 'shop_reporting', async () => {
        await expect(db.query(`SELECT * FROM ${table}`)).rejects.toMatchObject(denied);
      });
    });
  }
});

test.describe('shop_customer: row-level security', () => {
  test('sees only their own orders, items, payments and customer row', async ({ db }) => {
    await as(
      db,
      'shop_customer',
      async () => {
        const ids = async (sql: string) => (await db.query(sql)).rows.map((r) => Object.values(r)[0]);
        expect(await ids('SELECT id FROM orders ORDER BY id')).toEqual([1, 2]);
        expect(await ids('SELECT DISTINCT order_id FROM order_items ORDER BY order_id')).toEqual([1, 2]);
        expect(await ids('SELECT order_id FROM payments')).toEqual([1]);
        expect(await ids('SELECT name FROM customers')).toEqual(['Ana']);
      },
      1, // Ana
    );
  });

  test("another customer's order is not an error, it is simply not there", async ({ db }) => {
    await as(
      db,
      'shop_customer',
      async () => {
        const { rows } = await db.query('SELECT * FROM orders WHERE id = 3'); // Bruno's
        expect(rows).toEqual([]);
      },
      1,
    );
  });

  test('sees nothing when the customer is not set', async ({ db }) => {
    await as(db, 'shop_customer', async () => {
      const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM orders');
      expect(rows[0].n).toBe(0);
    });
  });

  test('sees nothing, without an error, when the setting is an empty string', async ({ db }) => {
    await rolledBack(db, async () => {
      // After a transaction that set app.customer_id ends, the session keeps
      // the setting as '' (not NULL), and ''::int would fail with 22P02.
      // current_customer_id() turns '' into NULL, which matches no row.
      await db.query(`SELECT set_config('app.customer_id', '', true)`);
      await db.query('SET LOCAL ROLE shop_customer');
      const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM orders');
      expect(rows[0].n).toBe(0);
    });
  });

  test('cannot write, even to their own rows', async ({ db }) => {
    await as(
      db,
      'shop_customer',
      async () => {
        await expect(db.query(`UPDATE orders SET status = 'CANCELLED' WHERE id = 2`)).rejects.toMatchObject(denied);
      },
      1,
    );
  });

  test('order_totals is security_invoker, so RLS applies through it', async ({ db }) => {
    await as(
      db,
      'shop_customer',
      async () => {
        const { rows } = await db.query('SELECT order_id, total FROM order_totals ORDER BY order_id');
        expect(rows).toEqual([
          { order_id: 1, total: '250.00' },
          { order_id: 2, total: '50.00' },
        ]);
      },
      1,
    );
  });

  test('a plain view would leak every order: it reads as its owner, who ignores RLS', async ({ db }) => {
    await rolledBack(db, async () => {
      await db.query('CREATE VIEW leaky_orders AS SELECT * FROM orders');
      await db.query('GRANT SELECT ON leaky_orders TO shop_customer');
      await db.query('SET LOCAL ROLE shop_customer');
      await db.query(`SELECT set_config('app.customer_id', '1', true)`);

      const direct = (await db.query('SELECT COUNT(*)::int AS n FROM orders')).rows[0].n;
      const throughView = (await db.query('SELECT COUNT(*)::int AS n FROM leaky_orders')).rows[0].n;
      expect(direct).toBe(2);
      expect(throughView).toBe(4); // every customer's orders
    });
  });

  test('cannot read the cross-customer views', async ({ db }) => {
    await as(
      db,
      'shop_customer',
      async () => {
        await expect(db.query('SELECT * FROM customer_order_history')).rejects.toMatchObject(denied);
      },
      1,
    );
  });
});
