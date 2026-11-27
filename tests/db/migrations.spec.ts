import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import { migrate } from '../../db/migrate.ts';
import { test as base, expect, DB_URL } from './db.fixture';

// The migration runner (db/migrate.ts) and an upgrade: a database built at an
// older version, given data, then migrated to the latest. Each test works on
// its own database, created and dropped here, so it can commit freely.

const initDir = path.join(__dirname, '..', '..', 'db', 'init');

function urlFor(database: string): string {
  const url = new URL(DB_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

async function admin<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: urlFor('postgres') });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// A new, empty database for one test, dropped at the end even if the test failed.
const test = base.extend<{ database: { url: string; client: Client } }>({
  database: async ({}, use) => {
    const name = `migration_test_${randomUUID().slice(0, 8)}`;
    await admin((c) => c.query(`CREATE DATABASE ${name}`));
    const client = new Client({ connectionString: urlFor(name) });
    await client.connect();
    try {
      await use({ url: urlFor(name), client });
    } finally {
      await client.end();
      await admin((c) => c.query(`DROP DATABASE ${name} WITH (FORCE)`));
    }
  },
});

// A copy of db/init that a test may change.
async function copyOfMigrations(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'migrations-'));
  await cp(initDir, dir, { recursive: true });
  return dir;
}

test.describe('migration runner', () => {
  test('applies every migration once, and nothing on the second run', async ({ database }) => {
    const first = await migrate(database.url, { dir: initDir });
    const second = await migrate(database.url, { dir: initDir });

    expect(first.applied.length).toBeGreaterThanOrEqual(12);
    expect(first.applied[0]).toBe('01_schema');
    expect(second).toEqual({ applied: [], skipped: first.applied });
  });

  test('stops when a migration already applied was edited', async ({ database }) => {
    const dir = await copyOfMigrations();
    try {
      await migrate(database.url, { dir });
      await appendFile(path.join(dir, '03_seed.sql'), "\nINSERT INTO customers (name, email) VALUES ('Late', 'late@example.com');\n");

      await expect(migrate(database.url, { dir })).rejects.toThrow(
        'migration 03_seed was changed after it was applied',
      );
      const { rows } = await database.client.query(`SELECT COUNT(*)::int AS n FROM customers WHERE email = 'late@example.com'`);
      expect(rows[0].n).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('rolls back a failing migration whole and does not record it', async ({ database }) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'migrations-'));
    try {
      await writeFile(path.join(dir, '01_good.sql'), 'CREATE TABLE good (id INT);');
      await writeFile(path.join(dir, '02_bad.sql'), 'CREATE TABLE half_done (id INT);\nSELECT 1 / 0;');

      await expect(migrate(database.url, { dir })).rejects.toThrow('migration 02_bad failed: division by zero');

      const { rows } = await database.client.query(`
        SELECT (SELECT array_agg(version ORDER BY version) FROM schema_migrations) AS recorded,
               to_regclass('good') IS NOT NULL AS good,
               to_regclass('half_done') IS NOT NULL AS half_done`);
      expect(rows[0]).toEqual({ recorded: ['01_good'], good: true, half_done: false });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('two runners at the same time apply each migration once', async ({ database }) => {
    // The advisory lock makes the second wait; it then finds everything applied.
    const [a, b] = await Promise.all([migrate(database.url, { dir: initDir }), migrate(database.url, { dir: initDir })]);

    const applied = [...a.applied, ...b.applied].sort();
    expect(applied).toEqual([...new Set(applied)]); // no migration twice
    expect(Math.min(a.applied.length, b.applied.length)).toBe(0);
    const { rows } = await database.client.query('SELECT COUNT(*)::int AS n FROM schema_migrations');
    expect(rows[0].n).toBe(applied.length);
  });
});

// Builds a database at 10_security, the version before audit_log was
// partitioned, and gives it history: orders through the procedures (their
// audit rows land in the plain audit_log) and older audit rows from past months.
async function databaseAtVersion10WithHistory(url: string, client: Client) {
  await migrate(url, { dir: initDir, to: '10_security' });
  await client.query(`CALL place_order(1, '[{"product_id": 1, "quantity": 1}]')`);
  await client.query(`CALL place_order(2, '[{"product_id": 2, "quantity": 2}]')`);
  await client.query(`CALL pay_order(5, 'PIX')`);
  await client.query(`CALL cancel_order(6)`);
  await client.query(`
    INSERT INTO audit_log (table_name, operation, row_id, changed_by, changed_at)
    VALUES ('orders', 'INSERT', 1, 'history', now() - INTERVAL '6 months'),
           ('orders', 'INSERT', 2, 'history', now() - INTERVAL '6 months' + INTERVAL '1 day'),
           ('orders', 'INSERT', 3, 'history', now() - INTERVAL '3 years')`);
}

// Every audit row, as one fingerprint, plus the highest id.
async function auditFingerprint(client: Client) {
  const { rows } = await client.query(`
    SELECT COUNT(*)::int AS rows,
           MAX(id)::int AS max_id,
           md5(string_agg(id || table_name || operation || row_id || coalesce(changed_fields::TEXT, '')
                          || changed_by || changed_at::TEXT, ',' ORDER BY id)) AS fingerprint
    FROM audit_log`);
  return rows[0];
}

const monthOf = (interval: string) =>
  `'audit_log_' || to_char(date_trunc('month', now() - INTERVAL '${interval}'), 'YYYY_MM')`;

test.describe('upgrade: audit history through the partitioning migrations', () => {
  test('11 alone leaves old history in the default partition, where it blocks new partitions', async ({ database }) => {
    await databaseAtVersion10WithHistory(database.url, database.client);
    await migrate(database.url, { dir: initDir, to: '11_performance' });

    const { rows } = await database.client.query(`
      SELECT COUNT(*)::int AS n FROM audit_log_default WHERE changed_by = 'history'`);
    expect(rows[0].n).toBe(3);

    // The bug 12 fixes: that month can no longer get its own partition.
    await expect(
      database.client.query(`SELECT create_audit_partition((now() - INTERVAL '6 months')::DATE)`),
    ).rejects.toMatchObject({ code: '23514' });
  });

  test('11 and 12 keep every audit row, each in its own month', async ({ database }) => {
    await databaseAtVersion10WithHistory(database.url, database.client);
    const before = await auditFingerprint(database.client);

    const result = await migrate(database.url, { dir: initDir });
    expect(result.applied).toEqual(expect.arrayContaining(['11_performance', '12_audit_partition_backfill']));

    // Same rows, same ids, same content.
    expect(await auditFingerprint(database.client)).toEqual(before);

    // Each row sits in the partition of its month; the default is empty.
    const { rows } = await database.client.query(`
      SELECT (SELECT COUNT(*)::int FROM audit_log_default) AS in_default,
             (SELECT array_agg(DISTINCT tableoid::REGCLASS::TEXT) FROM audit_log WHERE changed_by = 'history') AS partitions,
             ARRAY[${monthOf('3 years')}, ${monthOf('6 months')}] AS expected`);
    expect(rows[0].in_default).toBe(0);
    expect([...rows[0].partitions].sort()).toEqual([...rows[0].expected].sort());

    // The database works on top: ids continue after the history, the log is
    // still append-only, and new changes are audited.
    await database.client.query(`UPDATE products SET price = price + 1 WHERE id = 3`);
    const next = await database.client.query(`SELECT MAX(id)::int AS max_id FROM audit_log`);
    expect(next.rows[0].max_id).toBeGreaterThan(before.max_id);
    await expect(database.client.query('DELETE FROM audit_log')).rejects.toMatchObject({ code: 'SH004' });
  });

  test('on a database without history, 12 changes nothing', async ({ database }) => {
    await migrate(database.url, { dir: initDir, to: '11_performance' });
    const before = await auditFingerprint(database.client);
    const partitionsBefore = await database.client.query(
      `SELECT array_agg(inhrelid::REGCLASS::TEXT ORDER BY 1) AS p FROM pg_inherits WHERE inhparent = 'audit_log'::REGCLASS`,
    );

    await migrate(database.url, { dir: initDir });

    expect(await auditFingerprint(database.client)).toEqual(before);
    const partitionsAfter = await database.client.query(
      `SELECT array_agg(inhrelid::REGCLASS::TEXT ORDER BY 1) AS p FROM pg_inherits WHERE inhparent = 'audit_log'::REGCLASS`,
    );
    expect(partitionsAfter.rows[0].p).toEqual(partitionsBefore.rows[0].p);
  });
});
