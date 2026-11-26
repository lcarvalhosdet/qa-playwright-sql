import type { Client } from 'pg';
import { test, expect, rolledBack } from './db.fixture';

// The procedures in db/init/05_procedures.sql.
//   P0002 no_data_found   22023 invalid_parameter_value   23514 check_violation
//   SH001 insufficient stock   SH002 invalid status change (custom codes)
//   42809 wrong_object_type    2D000 invalid_transaction_termination

type Item = { product_id: number; quantity: number };

async function placeOrder(db: Client, customerId: number, items: unknown): Promise<number> {
  const { rows } = await db.query('CALL place_order($1, $2)', [customerId, JSON.stringify(items)]);
  return rows[0].p_order_id; // the INOUT parameter comes back as a row
}

async function stockOf(db: Client, ...ids: number[]): Promise<number[]> {
  const { rows } = await db.query('SELECT stock FROM products WHERE id = ANY($1) ORDER BY id', [ids]);
  return rows.map((row) => row.stock);
}

async function statusOf(db: Client, orderId: number): Promise<string> {
  const { rows } = await db.query('SELECT status FROM orders WHERE id = $1', [orderId]);
  return rows[0].status;
}

const keyboardAndMice: Item[] = [
  { product_id: 1, quantity: 2 }, // Keyboard 150.00, stock 10
  { product_id: 2, quantity: 3 }, // Mouse 50.00, stock 25
];

test.describe('place_order', () => {
  test('creates a PENDING order, copies the prices and takes the stock', async ({ db }) => {
    await rolledBack(db, async () => {
      const orderId = await placeOrder(db, 1, keyboardAndMice);

      expect(await statusOf(db, orderId)).toBe('PENDING');
      const { rows: items } = await db.query(
        'SELECT product_id, quantity, unit_price FROM order_items WHERE order_id = $1 ORDER BY product_id',
        [orderId],
      );
      expect(items).toEqual([
        { product_id: 1, quantity: 2, unit_price: '150.00' },
        { product_id: 2, quantity: 3, unit_price: '50.00' },
      ]);
      expect(await stockOf(db, 1, 2)).toEqual([8, 22]);
    });
  });

  test('keeps the price paid when the product price changes later', async ({ db }) => {
    await rolledBack(db, async () => {
      const orderId = await placeOrder(db, 1, keyboardAndMice);
      await db.query('UPDATE products SET price = price * 2');

      const { rows } = await db.query('SELECT order_total($1) AS total', [orderId]);
      expect(rows[0].total).toBe('450.00');
    });
  });

  test('takes the last unit of stock', async ({ db }) => {
    await rolledBack(db, async () => {
      await placeOrder(db, 2, [{ product_id: 3, quantity: 3 }]); // Monitor, stock 3
      expect(await stockOf(db, 3)).toEqual([0]);
    });
  });

  test('rejects an order above the stock with SH001 and a detail', async ({ db }) => {
    await rolledBack(db, async () => {
      await expect(placeOrder(db, 1, [{ product_id: 3, quantity: 4 }])).rejects.toMatchObject({
        code: 'SH001',
        message: 'insufficient stock for product 3',
        detail: 'requested 4, in stock 3',
      });
    });
  });

  // No rolledBack here on purpose: the CALL runs on its own, in autocommit.
  // The first item would succeed and the second fails, so if the procedure were
  // not atomic the order and the keyboard stock change would stay committed.
  test('is atomic: a failing item undoes the whole order', async ({ db }) => {
    const before = await db.query('SELECT COUNT(*)::int AS orders FROM orders');

    await expect(
      placeOrder(db, 1, [
        { product_id: 1, quantity: 1 },
        { product_id: 3, quantity: 99 },
      ]),
    ).rejects.toMatchObject({ code: 'SH001' });

    const after = await db.query('SELECT COUNT(*)::int AS orders FROM orders');
    expect(after.rows[0].orders).toBe(before.rows[0].orders);
    expect(await stockOf(db, 1)).toEqual([10]);
  });

  const invalidInputs = [
    { name: 'an unknown customer', customer: 999, items: keyboardAndMice, code: 'P0002', message: 'customer 999 does not exist' },
    { name: 'items that are not an array', customer: 1, items: { product_id: 1 }, code: '22023', message: 'items must be a JSON array' },
    { name: 'an empty list of items', customer: 1, items: [], code: '22023', message: 'an order needs at least one item' },
    { name: 'a zero quantity', customer: 1, items: [{ product_id: 1, quantity: 0 }], code: '22023', message: 'quantity must be positive, got 0' },
    { name: 'a missing quantity', customer: 1, items: [{ product_id: 1 }], code: '22023', message: 'quantity must be positive, got NULL' },
    { name: 'an unknown product', customer: 1, items: [{ product_id: 999, quantity: 1 }], code: 'P0002', message: 'product 999 does not exist' },
    {
      name: 'the same product twice',
      customer: 1,
      items: [{ product_id: 1, quantity: 1 }, { product_id: 1, quantity: 1 }],
      code: '22023',
      message: 'a product appears more than once in the order',
    },
  ];
  for (const { name, customer, items, code, message } of invalidInputs) {
    test(`rejects ${name}`, async ({ db }) => {
      await rolledBack(db, async () => {
        await expect(placeOrder(db, customer, items)).rejects.toMatchObject({ code, message });
      });
    });
  }

  test('is a procedure, so SELECT cannot call it', async ({ db }) => {
    await expect(db.query(`SELECT place_order(1, '[]')`)).rejects.toMatchObject({
      code: '42809',
      hint: 'To call a procedure, use CALL.',
    });
  });
});

test.describe('pay_order', () => {
  test('charges the order total and marks the order PAID', async ({ db }) => {
    await rolledBack(db, async () => {
      const orderId = await placeOrder(db, 1, keyboardAndMice);
      await db.query(`CALL pay_order($1, 'PIX')`, [orderId]);

      expect(await statusOf(db, orderId)).toBe('PAID');
      const { rows } = await db.query('SELECT amount, method FROM payments WHERE order_id = $1', [orderId]);
      expect(rows).toEqual([{ amount: '450.00', method: 'PIX' }]);
    });
  });

  test('refuses to pay an order twice', async ({ db }) => {
    await rolledBack(db, async () => {
      await expect(db.query(`CALL pay_order(1, 'CARD')`)).rejects.toMatchObject({
        code: 'SH002',
        message: 'order 1 is PAID and cannot be paid',
      });
    });
  });

  test('lets the CHECK constraint reject an unknown payment method', async ({ db }) => {
    await rolledBack(db, async () => {
      await expect(db.query(`CALL pay_order(2, 'CASH')`)).rejects.toMatchObject({
        code: '23514',
        constraint: 'payments_method_check',
      });
    });
  });
});

test.describe('cancel_order', () => {
  test('returns the items to stock', async ({ db }) => {
    await rolledBack(db, async () => {
      const orderId = await placeOrder(db, 1, keyboardAndMice);
      expect(await stockOf(db, 1, 2)).toEqual([8, 22]);

      await db.query('CALL cancel_order($1)', [orderId]);

      expect(await statusOf(db, orderId)).toBe('CANCELLED');
      expect(await stockOf(db, 1, 2)).toEqual([10, 25]);
    });
  });

  test('cancels a paid order and keeps its payment', async ({ db }) => {
    await rolledBack(db, async () => {
      await db.query('CALL cancel_order(1)');
      expect(await statusOf(db, 1)).toBe('CANCELLED');
      const { rows } = await db.query('SELECT COUNT(*)::int AS payments FROM payments WHERE order_id = 1');
      expect(rows[0].payments).toBe(1);
    });
  });

  test('refuses to cancel an order twice', async ({ db }) => {
    await rolledBack(db, async () => {
      await expect(db.query('CALL cancel_order(4)')).rejects.toMatchObject({
        code: 'SH002',
        message: 'order 4 is CANCELLED and cannot be cancelled',
      });
    });
  });

  test('raises no_data_found for an order that does not exist', async ({ db }) => {
    await expect(db.query('CALL cancel_order(999)')).rejects.toMatchObject({ code: 'P0002' });
  });
});

test.describe('expire_pending_orders', () => {
  // The batch behavior, with real COMMITs, is in expire.serial.spec.ts.
  test('cannot COMMIT when the CALL is inside a transaction', async ({ db }) => {
    await rolledBack(db, async () => {
      await db.query(`INSERT INTO orders (customer_id, created_at) VALUES (3, '1999-01-01')`);
      await expect(db.query(`CALL expire_pending_orders('2000-01-01')`)).rejects.toMatchObject({
        code: '2D000',
      });
    });
  });

  test('rejects a batch size below 1', async ({ db }) => {
    await expect(db.query(`CALL expire_pending_orders(now(), 0)`)).rejects.toMatchObject({ code: '22023' });
  });
});
