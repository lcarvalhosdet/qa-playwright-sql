import type { Client } from 'pg';
import { test, expect } from './api.fixture';

// POST /orders, payment and cancellation, from the HTTP response down to the
// rows the procedures changed.

async function stockOf(db: Client, ...ids: number[]): Promise<number[]> {
  const { rows } = await db.query('SELECT stock FROM products WHERE id = ANY($1) ORDER BY id', [ids]);
  return rows.map((row) => row.stock);
}

async function ordersOf(db: Client, customerId: number): Promise<number> {
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM orders WHERE customer_id = $1', [customerId]);
  return rows[0].n;
}

test.describe('POST /orders', () => {
  test('creates the order, and the database shows every effect of place_order', async ({ api, db, scratch }) => {
    const customer = await scratch.customer();
    const keyboard = await scratch.product(10, 150);
    const mouse = await scratch.product(25, 50);

    const response = await api.post('/orders', {
      data: {
        customerId: customer,
        items: [
          { productId: keyboard, quantity: 2 },
          { productId: mouse, quantity: 3 },
        ],
      },
    });

    expect(response.status()).toBe(201);
    const order = await response.json();
    expect(response.headers()['location']).toBe(`/orders/${order.id}`);
    expect(order).toMatchObject({
      customerId: customer,
      status: 'PENDING',
      total: '450.00',
      payment: null,
      items: [
        { productId: keyboard, quantity: 2, unitPrice: '150.00', subtotal: '300.00' },
        { productId: mouse, quantity: 3, unitPrice: '50.00', subtotal: '150.00' },
      ],
    });

    // The stock went down in the same call.
    expect(await stockOf(db, keyboard, mouse)).toEqual([8, 22]);

    // The audit trigger logged the order and both stock changes in one transaction.
    const { rows: audit } = await db.query(
      `SELECT table_name, operation, row_id, changed_fields, transaction_id
       FROM audit_log
       WHERE (table_name = 'orders' AND row_id = $1) OR (table_name = 'products' AND row_id = ANY($2))
       ORDER BY id`,
      [order.id, [keyboard, mouse]],
    );
    expect(audit.map((a) => [a.table_name, a.operation, a.row_id, a.changed_fields])).toEqual([
      ['products', 'INSERT', keyboard, null], // made by scratch
      ['products', 'INSERT', mouse, null],
      ['orders', 'INSERT', order.id, null],
      ['products', 'UPDATE', keyboard, ['stock']],
      ['products', 'UPDATE', mouse, ['stock']],
    ]);
    expect(new Set(audit.slice(2).map((a) => a.transaction_id)).size).toBe(1);
  });

  test('409 SH001 when the stock is short, and nothing is saved', async ({ api, db, scratch }) => {
    const customer = await scratch.customer();
    const monitor = await scratch.product(1);

    const response = await api.post('/orders', {
      data: { customerId: customer, items: [{ productId: monitor, quantity: 2 }] },
    });

    expect(response.status()).toBe(409);
    expect(await response.json()).toEqual({
      code: 'SH001',
      error: `insufficient stock for product ${monitor}`,
      detail: 'requested 2, in stock 1',
    });
    expect(await ordersOf(db, customer)).toBe(0);
    expect(await stockOf(db, monitor)).toEqual([1]);
  });

  test('404 for a customer or a product that does not exist', async ({ api, scratch }) => {
    const customer = await scratch.customer();
    const product = await scratch.product(5);

    const unknownCustomer = await api.post('/orders', {
      data: { customerId: 999999, items: [{ productId: product, quantity: 1 }] },
    });
    expect(unknownCustomer.status()).toBe(404);
    expect(await unknownCustomer.json()).toEqual({ code: 'P0002', error: 'customer 999999 does not exist' });

    const unknownProduct = await api.post('/orders', {
      data: { customerId: customer, items: [{ productId: 999999, quantity: 1 }] },
    });
    expect(unknownProduct.status()).toBe(404);
    expect(await unknownProduct.json()).toEqual({ code: 'P0002', error: 'product 999999 does not exist' });
  });

  test('422 when the same product comes twice, with the hint from the procedure', async ({ api, db, scratch }) => {
    const customer = await scratch.customer();
    const product = await scratch.product(5);

    const response = await api.post('/orders', {
      data: {
        customerId: customer,
        items: [
          { productId: product, quantity: 1 },
          { productId: product, quantity: 1 },
        ],
      },
    });

    expect(response.status()).toBe(422);
    expect(await response.json()).toEqual({
      code: '22023',
      error: 'a product appears more than once in the order',
      hint: 'Send each product once with the total quantity.',
    });
    expect(await ordersOf(db, customer)).toBe(0);
  });

  // The JSON schema stops these in the API, before any SQL runs. The ids do
  // not exist, so if validation ever let one through, the database would answer
  // 404 and the test would still fail, without writing anything.
  const id = 999999;
  const malformed = [
    { name: 'no customerId', body: { items: [{ productId: id, quantity: 1 }] } },
    { name: 'an empty list of items', body: { customerId: id, items: [] } },
    { name: 'a zero quantity', body: { customerId: id, items: [{ productId: id, quantity: 0 }] } },
    { name: 'a quantity that is not a number', body: { customerId: id, items: [{ productId: id, quantity: 'two' }] } },
    { name: 'a misspelled field', body: { customerId: id, items: [{ productId: id, quantiy: 1 }] } },
    // Fastify drops unknown fields by default; app.ts turns that off.
    { name: 'a field the API does not know', body: { customerId: id, items: [{ productId: id, quantity: 1 }], discount: 50 } },
  ];
  for (const { name, body } of malformed) {
    test(`400 for ${name}`, async ({ api }) => {
      const response = await api.post('/orders', { data: body });
      expect(response.status()).toBe(400);
      expect((await response.json()).code).toBe('VALIDATION');
    });
  }

  test('400 for a body that is not valid JSON', async ({ api }) => {
    const response = await api.post('/orders', {
      headers: { 'content-type': 'application/json' },
      data: '{"customerId": 999999,',
    });
    expect(response.status()).toBe(400);
  });
});

test.describe('GET /orders/:id', () => {
  test('404 for an order that does not exist', async ({ api }) => {
    const response = await api.get('/orders/999999');
    expect(response.status()).toBe(404);
    expect(await response.json()).toEqual({ code: 'P0002', error: 'order 999999 does not exist' });
  });

  test('400 for an id that is not a number', async ({ api }) => {
    expect((await api.get('/orders/abc')).status()).toBe(400);
  });
});

test.describe('payment and cancellation', () => {
  async function placeOrder(api: import('@playwright/test').APIRequestContext, customerId: number, productId: number) {
    const response = await api.post('/orders', { data: { customerId, items: [{ productId, quantity: 2 }] } });
    expect(response.status()).toBe(201);
    return (await response.json()).id as number;
  }

  test('pays a pending order: PAID, with a payment of the order total', async ({ api, db, scratch }) => {
    const orderId = await placeOrder(api, await scratch.customer(), await scratch.product(5, 30));

    const response = await api.post(`/orders/${orderId}/payment`, { data: { method: 'PIX' } });

    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'PAID',
      total: '60.00',
      payment: { amount: '60.00', method: 'PIX' },
    });
    const { rows } = await db.query('SELECT amount, method FROM payments WHERE order_id = $1', [orderId]);
    expect(rows).toEqual([{ amount: '60.00', method: 'PIX' }]);
  });

  test('409 SH002 for a second payment of the same order', async ({ api, scratch }) => {
    const orderId = await placeOrder(api, await scratch.customer(), await scratch.product(5));
    await api.post(`/orders/${orderId}/payment`, { data: { method: 'CARD' } });

    const again = await api.post(`/orders/${orderId}/payment`, { data: { method: 'CARD' } });

    expect(again.status()).toBe(409);
    expect(await again.json()).toEqual({ code: 'SH002', error: `order ${orderId} is PAID and cannot be paid` });
  });

  test('400 for a payment method the API does not accept', async ({ api, db, scratch }) => {
    const orderId = await placeOrder(api, await scratch.customer(), await scratch.product(5));

    const response = await api.post(`/orders/${orderId}/payment`, { data: { method: 'CASH' } });

    expect(response.status()).toBe(400);
    const { rows } = await db.query('SELECT status FROM orders WHERE id = $1', [orderId]);
    expect(rows[0].status).toBe('PENDING');
  });

  test('cancels an order and puts the stock back; a second cancel is 409', async ({ api, db, scratch }) => {
    const product = await scratch.product(5);
    const orderId = await placeOrder(api, await scratch.customer(), product);
    expect(await stockOf(db, product)).toEqual([3]);

    const response = await api.post(`/orders/${orderId}/cancel`);

    expect(response.status()).toBe(200);
    expect((await response.json()).status).toBe('CANCELLED');
    expect(await stockOf(db, product)).toEqual([5]);

    const again = await api.post(`/orders/${orderId}/cancel`);
    expect(again.status()).toBe(409);
    expect(await again.json()).toEqual({
      code: 'SH002',
      error: `order ${orderId} is CANCELLED and cannot be cancelled`,
    });
  });
});

test.describe('concurrency through the API', () => {
  test('two orders at the same moment for the last unit: one 201, one 409', async ({ api, db, scratch }) => {
    const product = await scratch.product(1);
    const [c1, c2] = [await scratch.customer(), await scratch.customer()];
    const order = (customerId: number) =>
      api.post('/orders', { data: { customerId, items: [{ productId: product, quantity: 1 }] } });

    // Both requests leave together; the API's connection pool runs them on
    // two connections, and place_order's row lock decides who gets the unit.
    const responses = await Promise.all([order(c1), order(c2)]);

    expect(responses.map((r) => r.status()).sort()).toEqual([201, 409]);
    expect(await stockOf(db, product)).toEqual([0]);
    const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM order_items WHERE product_id = $1', [product]);
    expect(rows[0].n).toBe(1);
  });
});
