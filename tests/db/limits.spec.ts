import type { Client } from 'pg';
import { test, expect, rolledBack } from './db.fixture';

// The pending-order limit in db/init/09_order_limits.sql, one session at a
// time. How it behaves under concurrency is in concurrency.serial.spec.ts.

async function newCustomer(db: Client, limit: number): Promise<number> {
  const { rows } = await db.query(
    `INSERT INTO customers (name, email, max_pending_orders) VALUES ('Limit test', 'limit@example.com', $1) RETURNING id`,
    [limit],
  );
  return rows[0].id;
}

const placeOrder = (db: Client, customerId: number) =>
  db.query('CALL place_order($1, $2)', [customerId, JSON.stringify([{ product_id: 2, quantity: 1 }])]);

test.describe('pending-order limit', () => {
  test('rejects the order over the limit with SH006, detail and hint', async ({ db }) => {
    await rolledBack(db, async () => {
      const customer = await newCustomer(db, 2);
      await placeOrder(db, customer);
      await placeOrder(db, customer);

      await expect(placeOrder(db, customer)).rejects.toMatchObject({
        code: 'SH006',
        message: `customer ${customer} already has 2 pending orders`,
        detail: 'the limit is 2',
        hint: 'Pay or cancel a pending order first.',
      });
    });
  });

  test('paying or cancelling an order frees a place', async ({ db }) => {
    await rolledBack(db, async () => {
      const customer = await newCustomer(db, 2);
      const first = (await placeOrder(db, customer)).rows[0].p_order_id;
      const second = (await placeOrder(db, customer)).rows[0].p_order_id;

      await db.query(`CALL pay_order($1, 'PIX')`, [first]);
      await expect(placeOrder(db, customer)).resolves.toBeDefined(); // 2 pending again

      await db.query('CALL cancel_order($1)', [second]);
      await expect(placeOrder(db, customer)).resolves.toBeDefined();
    });
  });

  test('orders created as PAID or CANCELLED do not count', async ({ db }) => {
    await rolledBack(db, async () => {
      const customer = await newCustomer(db, 1);
      await db.query(
        `INSERT INTO orders (customer_id, status) VALUES ($1, 'PAID'), ($1, 'CANCELLED'), ($1, 'PAID')`,
        [customer],
      );
      await expect(placeOrder(db, customer)).resolves.toBeDefined();
    });
  });

  test('the limit must be positive', async ({ db }) => {
    await rolledBack(db, async () => {
      await expect(db.query('UPDATE customers SET max_pending_orders = 0 WHERE id = 1')).rejects.toMatchObject({
        code: '23514',
        constraint: 'customers_max_pending_orders_check',
      });
    });
  });
});
