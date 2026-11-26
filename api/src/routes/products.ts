import type { FastifyInstance } from 'fastify';
import { notFound } from '../errors.ts';

// Money goes out as a string ("150.00"), as PostgreSQL returns NUMERIC, so no
// value passes through a floating-point number.
const productColumns = `
  id, sku, name, price, stock, version, category_id AS "categoryId"`;

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
} as const;

export async function productRoutes(app: FastifyInstance): Promise<void> {
  app.get('/products', async () => {
    const { rows } = await app.db.query(`SELECT ${productColumns} FROM products ORDER BY id`);
    return rows;
  });

  app.get<{ Params: { id: number } }>('/products/:id', { schema: { params: idParams } }, async (request) => {
    const { rows } = await app.db.query(`SELECT ${productColumns} FROM products WHERE id = $1`, [request.params.id]);
    if (rows.length === 0) throw notFound(`product ${request.params.id} does not exist`);
    return rows[0];
  });

  // Optimistic locking (08_concurrency.sql): the client sends the version it
  // read, and gets 409 SH005 if someone changed the product since.
  app.patch<{ Params: { id: number }; Body: { price: number; version: number } }>(
    '/products/:id/price',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['price', 'version'],
          additionalProperties: false,
          properties: {
            price: { type: 'number', exclusiveMinimum: 0 },
            version: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (request) => {
      const { id } = request.params;
      const { price, version } = request.body;
      await app.db.query('SELECT update_product_price($1, $2, $3)', [id, price, version]);
      const { rows } = await app.db.query(`SELECT ${productColumns} FROM products WHERE id = $1`, [id]);
      return rows[0];
    },
  );
}
