import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, rolledBack } from './db.fixture';

// Runs the pgTAP files in db/tests, one Playwright test per file. Each file
// runs inside a transaction that is rolled back, with the tap schema (where
// global-setup.ts installed pgTAP) first in the search_path. Every TAP line
// becomes a soft assertion, so a failing file lists all its failures by name.

const dir = path.join(__dirname, '..', '..', 'db', 'tests');
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

type TapLine = { ok: boolean; number: number; description: string };

// "ok 3 - has_table" / "not ok 4 - fk_ok ..." plus "1..48" and "# diagnostics".
function parseTap(lines: string[]) {
  const plan = lines.map((l) => /^1\.\.(\d+)$/.exec(l)).find(Boolean);
  const results: TapLine[] = [];
  for (const line of lines) {
    const match = /^(not ok|ok) (\d+)(?: - (.*))?$/.exec(line.split('\n')[0]);
    if (match) results.push({ ok: match[1] === 'ok', number: Number(match[2]), description: match[3] ?? '' });
  }
  return { planned: plan ? Number(plan[1]) : undefined, results };
}

for (const file of files) {
  test(`pgTAP ${file}`, async ({ db }) => {
    const { rows } = await db.query(`SELECT to_regnamespace('tap') IS NOT NULL AS installed`);
    // Only when someone points DB_URL at a database built from another image.
    // eslint-disable-next-line playwright/no-skipped-test
    test.skip(!rows[0].installed, 'pgTAP is not installed in this database');

    const lines = await rolledBack(db, async () => {
      await db.query('SET LOCAL search_path = tap, public');
      // A file is many statements; pg returns one result per statement.
      const results: unknown = await db.query(readFileSync(path.join(dir, file), 'utf8'));
      const all = (Array.isArray(results) ? results : [results]) as { rows: Record<string, unknown>[] }[];
      return all.flatMap((r) => r.rows.map((row) => String(Object.values(row)[0])));
    });

    const { planned, results } = parseTap(lines);
    for (const r of results) {
      expect.soft(r.ok, `${r.number} - ${r.description}`).toBe(true);
    }
    expect(planned, 'plan line').toBeDefined();
    expect(results, 'every planned assertion ran').toHaveLength(planned!);
  });
}
