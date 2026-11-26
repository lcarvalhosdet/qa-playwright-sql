import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { notFound } from '../errors.ts';

// Each write calls one procedure from 05_procedures.sql. The procedure
// validates, locks and writes in one statement, so the API does not need a
// transaction of its own, and every rule it enforces (stock, status changes,
// duplicates) reaches the client as an HTTP status through errors.ts.

type OrderItem = { productId: number; quantity: number };

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
} as const;

// The schema rejects malformed requests (400) before any SQL runs. Rules that
// need the data, such as stock or a product that does not exist, stay in the
// database.
const createOrderBody = {
  type: 'object',
  required: ['customerId', 'items'],
  additionalProperties: false,
  properties: {
    customerId: { type: 'integer', minimum: 1 },
    items: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['productId', 'quantity'],
        additionalProperties: false,
        properties: {
          productId: { type: 'integer', minimum: 1 },
          quantity: { type: 'integer', minimum: 1 },
        },
      },
    },
  },
} as const;

const paymentBody = {
  type: 'object',
  required: ['method'],
  additionalProperties: false,
  properties: { method: { type: 'string', enum: ['CARD', 'PIX', 'BOLETO'] } },
} as const;

export async function orderRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { customerId: number; items: OrderItem[] } }>(
    '/orders',
    { schema: { body: createOrderBody } },
    async (request, reply) => {
      const { customerId, items } = request.body;
      // The procedure takes the items as JSON, with its own field names.
      const json = JSON.stringify(items.map((i) => ({ product_id: i.productId, quantity: i.quantity })));
      const { rows } = await app.db.query('CALL place_order($1, $2)', [customerId, json]);
      const order = await getOrder(app.db, rows[0].p_order_id);
      return reply.status(201).header('location', `/orders/${order.id}`).send(order);
    },
  );

  app.get<{ Params: { id: number } }>('/orders/:id', { schema: { params: idParams } }, async (request) => {
    return getOrder(app.db, request.params.id);
  });

  app.post<{ Params: { id: number }; Body: { method: string } }>(
    '/orders/:id/payment',
    { schema: { params: idParams, body: paymentBody } },
    async (request) => {
      await app.db.query('CALL pay_order($1, $2)', [request.params.id, request.body.method]);
      return getOrder(app.db, request.params.id);
    },
  );

  app.post<{ Params: { id: number } }>('/orders/:id/cancel', { schema: { params: idParams } }, async (request) => {
    await app.db.query('CALL cancel_order($1)', [request.params.id]);
    return getOrder(app.db, request.params.id);
  });
}

// One order with its items and payment, read from the order_totals view.
async function getOrder(db: pg.Pool, id: number) {
  const { rows } = await db.query(
    `SELECT order_id AS id, customer_id AS "customerId", status, created_at AS "createdAt", total
     FROM order_totals
     WHERE order_id = $1`,
    [id],
  );
  if (rows.length === 0) throw notFound(`order ${id} does not exist`);

  const items = await db.query(
    `SELECT oi.product_id AS "productId", p.sku, oi.quantity, oi.unit_price AS "unitPrice", oi.subtotal
     FROM order_items oi
     JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = $1
     ORDER BY oi.product_id`,
    [id],
  );
  const payment = await db.query(
    `SELECT amount, method, paid_at AS "paidAt" FROM payments WHERE order_id = $1`,
    [id],
  );
  return { ...rows[0], items: items.rows, payment: payment.rows[0] ?? null };
}
