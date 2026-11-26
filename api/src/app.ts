import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { toHttpError } from './errors.ts';
import { orderRoutes } from './routes/orders.ts';
import { productRoutes } from './routes/products.ts';
import { reportRoutes } from './routes/reports.ts';

// A small REST API over the shop database. It holds no business rules of its
// own: each route calls a procedure, function or view from db/init, so the
// tests can follow a request from HTTP down to the rows it changed.
//
// buildApp only builds the app; the caller decides where it listens
// (main.ts for a standalone server, global-setup.ts for the tests).

declare module 'fastify' {
  interface FastifyInstance {
    db: pg.Pool;
  }
}

export function buildApp(databaseUrl: string): FastifyInstance {
  const app = Fastify({
    logger: false,
    // By default Fastify silently drops properties a schema does not list.
    // With removeAdditional off, additionalProperties: false rejects them
    // with 400, so a typo such as "quantiy" never goes unnoticed.
    ajv: { customOptions: { removeAdditional: false } },
  });

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  app.decorate('db', pool);
  app.addHook('onClose', async () => {
    await pool.end();
  });

  app.setErrorHandler((error, _request, reply) => {
    const { status, body } = toHttpError(error);
    void reply.status(status).send(body);
  });

  app.get('/health', async () => {
    await pool.query('SELECT 1');
    return { status: 'ok' };
  });

  void app.register(productRoutes);
  void app.register(orderRoutes);
  void app.register(reportRoutes);

  return app;
}
