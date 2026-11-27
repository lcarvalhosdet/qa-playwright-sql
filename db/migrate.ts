import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

// A small migration runner for the files in db/init.
//
// Each file is a migration, applied in name order, once, each in its own
// transaction. schema_migrations records which ones a database has, with a
// checksum of the file as it was applied:
//   - a file not recorded yet is applied and recorded;
//   - a file recorded with the same checksum is skipped;
//   - a file recorded with a different checksum stops the run: an applied
//     migration was edited, so this database and a fresh one would differ.
// A migration that fails is rolled back whole and not recorded, so the
// database stays at the last version that worked.
//
// Two runners started at once (two deploys, two CI jobs) take turns on an
// advisory lock instead of applying the same file twice.

export type MigrateOptions = {
  /** Folder with the .sql files, usually db/init. */
  dir: string;
  /** Stop after this migration (file name without .sql), for upgrade tests. */
  to?: string;
  log?: (message: string) => void;
};

export type MigrateResult = { applied: string[]; skipped: string[] };

const LOCK_KEY = 'qa-playwright-sql migrations';

export async function migrate(databaseUrl: string, options: MigrateOptions): Promise<MigrateResult> {
  const { dir } = options;
  const log = options.log ?? (() => {});
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  if (options.to && !files.includes(`${options.to}.sql`)) throw new Error(`no migration named ${options.to}`);

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     TEXT        PRIMARY KEY,
        checksum    TEXT        NOT NULL,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        duration_ms INTEGER     NOT NULL
      )`);
    const { rows } = await client.query('SELECT version, checksum FROM schema_migrations');
    const recorded = new Map<string, string>(rows.map((r) => [r.version, r.checksum]));

    const result: MigrateResult = { applied: [], skipped: [] };
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      const sql = await readFile(path.join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');

      const previous = recorded.get(version);
      if (previous === checksum) {
        result.skipped.push(version);
      } else if (previous) {
        throw new Error(
          `migration ${version} was changed after it was applied: write a new migration instead of editing it`,
        );
      } else {
        const started = Date.now();
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (version, checksum, duration_ms) VALUES ($1, $2, $3)', [
            version,
            checksum,
            Date.now() - started,
          ]);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw Object.assign(error as Error, { message: `migration ${version} failed: ${(error as Error).message}` });
        }
        result.applied.push(version);
        log(`applied ${version} (${Date.now() - started} ms)`);
      }
      if (version === options.to) break;
    }
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY]).catch(() => {});
    await client.end();
  }
}
