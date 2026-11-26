import path from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './api/src/app.ts';

// Starts what the selected projects need, and returns the function that stops it.
//
// Database (projects db, db-serial, shop-api): a fresh PostgreSQL 16 from
// Testcontainers, on a random free port, with every file in db/init loaded,
// exactly like docker-compose. Skipped when DB_URL is set: the tests then use
// that database instead.
//
// Shop API (project shop-api): the Fastify app from api/src, connected to that
// database, on a random free port. Skipped when SHOP_API_URL is set.
//
// Workers read DB_URL and SHOP_API_URL from the environment set here.
export default async function globalSetup(): Promise<() => Promise<void>> {
  const projects = selectedProjects();
  const wants = (prefix: string) => projects.length === 0 || projects.some((name) => name.startsWith(prefix));

  let container: StartedPostgreSqlContainer | undefined;
  let api: FastifyInstance | undefined;

  if ((wants('db') || wants('shop')) && !process.env.DB_URL) {
    container = await new PostgreSqlContainer('postgres:16')
      .withDatabase('shop')
      .withUsername('qa')
      .withPassword('qa')
      // mode: the files arrive owned by root, and the init scripts run as the
      // postgres user, which must be able to read them whatever the local mode.
      .withCopyDirectoriesToContainer([
        { source: path.join(__dirname, 'db', 'init'), target: '/docker-entrypoint-initdb.d', mode: 0o755 },
      ])
      .start();
    process.env.DB_URL = container.getConnectionUri();
    console.log(`PostgreSQL started by Testcontainers on port ${container.getPort()}`);
  }

  if (wants('shop') && !process.env.SHOP_API_URL) {
    api = buildApp(process.env.DB_URL!);
    process.env.SHOP_API_URL = await api.listen({ port: 0, host: '127.0.0.1' });
    console.log(`Shop API started on ${process.env.SHOP_API_URL}`);
  }

  return async () => {
    await api?.close(); // closes its connection pool first, then the database goes
    await container?.stop();
  };
}

// The names given with --project, if any.
function selectedProjects(): string[] {
  const args = process.argv;
  return args.flatMap((arg, i) => {
    if (arg.startsWith('--project=')) return [arg.slice('--project='.length)];
    if (arg === '--project' && args[i + 1]) return [args[i + 1]];
    return [];
  });
}
