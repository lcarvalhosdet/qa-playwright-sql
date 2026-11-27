import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer } from 'testcontainers';
import type { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { buildApp } from './api/src/app.ts';
import { migrate } from './db/migrate.ts';

// Starts what the selected projects need, and returns the function that stops it.
//
// Database (projects db, db-serial, shop-api, perf): a fresh PostgreSQL 16 from
// Testcontainers, on a random free port, with pg_stat_statements loaded at
// start and every migration in db/init applied by db/migrate.ts. Skipped when
// DB_URL is set: the tests then use that database, migrated to the latest
// version first.
//
// Performance database (project perf): shop_perf, a copy of that database
// made with CREATE DATABASE ... TEMPLATE, then filled by db/perf/volume.sql.
// Skipped when PERF_DB_URL is set.
//
// Shop API (project shop-api): the Fastify app from api/src, on a random free
// port, connected to that database as shop_api, the least-privilege role from
// 10_security.sql, not as the superuser. Skipped when SHOP_API_URL is set.
//
// Workers read DB_URL, PERF_DB_URL and SHOP_API_URL from the environment set here.
export default async function globalSetup(): Promise<() => Promise<void>> {
  const projects = selectedProjects();
  const wants = (prefix: string) => projects.length === 0 || projects.some((name) => name.startsWith(prefix));

  let container: StartedPostgreSqlContainer | undefined;
  let api: FastifyInstance | undefined;

  if ((wants('db') || wants('shop') || wants('perf')) && !process.env.DB_URL) {
    // postgres:16 plus pgTAP (db/docker/Dockerfile). Docker caches the build,
    // so after the first run this takes a moment.
    const image = 'qa-playwright-sql-postgres:16';
    await GenericContainer.fromDockerfile(path.join(__dirname, 'db', 'docker')).build(image, { deleteOnExit: false });
    container = await new PostgreSqlContainer(image)
      .withDatabase('shop')
      .withUsername('qa')
      .withPassword('qa')
      .withCommand(['postgres', '-c', 'shared_preload_libraries=pg_stat_statements'])
      .start();
    process.env.DB_URL = container.getConnectionUri();
    console.log(`PostgreSQL started by Testcontainers on port ${container.getPort()}`);
  }

  if (wants('db') || wants('shop') || wants('perf')) {
    const { applied } = await migrate(process.env.DB_URL!, { dir: path.join(__dirname, 'db', 'init') });
    console.log(`Migrations: ${applied.length} applied`);
    await installPgTap(process.env.DB_URL!);
  }

  // Before anything else connects to shop: a database can only be copied as a
  // template while nobody is connected to it.
  if (wants('perf') && !process.env.PERF_DB_URL) {
    process.env.PERF_DB_URL = await createPerfDatabase(process.env.DB_URL!);
  }

  if (wants('shop') && !process.env.SHOP_API_URL) {
    api = buildApp(withUser(process.env.DB_URL!, 'shop_api', 'shop_api'));
    process.env.SHOP_API_URL = await api.listen({ port: 0, host: '127.0.0.1' });
    console.log(`Shop API started on ${process.env.SHOP_API_URL}`);
  }

  return async () => {
    await api?.close(); // closes its connection pool first, then the database goes
    await container?.stop();
  };
}

// pgTAP goes into its own schema, tap, so test tooling stays out of public
// and out of the migrations. Without the extension (a database from another
// image), the pgTAP tests skip themselves.
async function installPgTap(databaseUrl: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('CREATE SCHEMA IF NOT EXISTS tap');
    await client.query('CREATE EXTENSION IF NOT EXISTS pgtap SCHEMA tap');
  } catch (error) {
    console.warn(`pgTAP not installed, its tests will be skipped: ${(error as Error).message}`);
  } finally {
    await client.end();
  }
}

// Copies shop into shop_perf and loads the volume. Returns its URL.
async function createPerfDatabase(shopUrl: string): Promise<string> {
  const started = Date.now();
  const admin = new Client({ connectionString: withDatabase(shopUrl, 'postgres') });
  await admin.connect();
  try {
    await admin.query('DROP DATABASE IF EXISTS shop_perf');
    await admin.query('CREATE DATABASE shop_perf TEMPLATE shop');
  } finally {
    await admin.end();
  }

  const perfUrl = withDatabase(shopUrl, 'shop_perf');
  const perf = new Client({ connectionString: perfUrl });
  await perf.connect();
  try {
    await perf.query(await readFile(path.join(__dirname, 'db', 'perf', 'volume.sql'), 'utf8'));
    // Fresh statistics for the planner, and a visibility map so an index can
    // answer a query without visiting the table (Index Only Scan). VACUUM
    // cannot run inside a transaction, so it is its own statement.
    await perf.query('VACUUM ANALYZE');
  } finally {
    await perf.end();
  }
  console.log(`Performance database shop_perf loaded in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return perfUrl;
}

// The same database URL with another user and password.
function withUser(databaseUrl: string, user: string, password: string): string {
  const url = new URL(databaseUrl);
  url.username = user;
  url.password = password;
  return url.toString();
}

// The same database URL pointing at another database.
function withDatabase(databaseUrl: string, database: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${database}`;
  return url.toString();
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
