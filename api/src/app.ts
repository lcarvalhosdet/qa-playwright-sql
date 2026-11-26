import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { toHttpError } from './errors.ts';
import { defaultRetryOptions, type RetryOptions } from './retry.ts';
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
    retry: RetryOptions;
  }
}

export function buildApp(databaseUrl: string, options: { retry?: Partial<RetryOptions> } = {}): FastifyInstance {
  const app = Fastify({
    logger: false,
    // By default Fastify silently drops properties a schema does not list.
    // With removeAdditional off, additionalProperties: false rejects them
    // with 400, so a typo such as "quantiy" never goes unnoticed.
    ajv: { customOptions: { removeAdditional: false } },
  });

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  app.decorate('db', pool);
  app.decorate('retry', { ...defaultRetryOptions, ...options.retry });
  app.addHook('onClose', async () => {
    await pool.end();
  });

  app.setErrorHandler((error, _request, reply) => {
    const { status, body } = toHttpError(error);
    // 503 means a transaction lost a race every time it was retried: the
    // request was fine, and the client may send it again.
    if (status === 503) void reply.header('retry-after', '1');
    // Set by api/src/retry.ts when the error ended a retried transaction.
    const attempts = (error as { attempts?: number } | null)?.attempts;
    if (attempts) void reply.header('x-transaction-attempts', String(attempts));
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
