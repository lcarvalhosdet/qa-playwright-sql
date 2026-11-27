import { test, expect, rolledBack } from './db.fixture';

// The partitioned audit_log from db/init/11_performance.sql, on the small seed.
// How partitions affect plans is in tests/perf, on the volume.

test.describe('audit_log partitions', () => {
  test('new audit rows land in the partition of the current month', async ({ db }) => {
    await rolledBack(db, async () => {
      await db.query('UPDATE products SET price = price + 1 WHERE id = 1');
      const { rows } = await db.query(`
        SELECT tableoid::REGCLASS::TEXT AS partition, 'audit_log_' || to_char(now(), 'YYYY_MM') AS expected
        FROM audit_log
        WHERE transaction_id = txid_current()`);
      expect(rows).toHaveLength(1);
      expect(rows[0].partition).toBe(rows[0].expected);
    });
  });

  test('a row for a month without a partition lands in the default one', async ({ db }) => {
    await rolledBack(db, async () => {
      const { rows } = await db.query(`
        INSERT INTO audit_log (table_name, operation, row_id, changed_at)
        VALUES ('orders', 'INSERT', 1, '2001-01-15')
        RETURNING tableoid::REGCLASS::TEXT AS partition`);
      expect(rows[0].partition).toBe('audit_log_default');
    });
  });

  test('create_audit_partition adds a month, once, with its own TRUNCATE guard', async ({ db }) => {
    await rolledBack(db, async () => {
      const first = await db.query(`SELECT create_audit_partition('2030-03-17') AS name`);
      const again = await db.query(`SELECT create_audit_partition('2030-03-01') AS name`);
      expect(first.rows[0].name).toBe('audit_log_2030_03');
      expect(again.rows[0].name).toBe('audit_log_2030_03'); // already there: nothing created

      // Indexes declared on the parent are created on the new partition too.
      const { rows } = await db.query(`
        SELECT indexrelid::REGCLASS::TEXT AS name FROM pg_index
        WHERE indrelid = 'audit_log_2030_03'::REGCLASS ORDER BY 1`);
      expect(rows.map((r) => r.name)).toEqual([
        'audit_log_2030_03_changed_at_idx',
        'audit_log_2030_03_pkey',
        'audit_log_2030_03_table_name_row_id_idx',
      ]);

      await expect(db.query('TRUNCATE audit_log_2030_03')).rejects.toMatchObject({
        code: 'SH004',
        message: 'audit_log is append-only: TRUNCATE is not allowed',
      });
    });
  });

  // Row triggers on the parent are copied to every partition; statement
  // triggers are not, so each partition needs its own TRUNCATE trigger.
  test('every partition has the append-only triggers', async ({ db }) => {
    const { rows } = await db.query(`
      SELECT p.inhrelid::REGCLASS::TEXT AS partition,
             array_agg(t.tgname::TEXT ORDER BY t.tgname) AS triggers
      FROM pg_inherits p
      JOIN pg_trigger t ON t.tgrelid = p.inhrelid AND NOT t.tgisinternal
      WHERE p.inhparent = 'audit_log'::REGCLASS
      GROUP BY p.inhrelid
      ORDER BY 1`);
    expect(rows.length).toBeGreaterThanOrEqual(4); // default and at least three months
    for (const row of rows) {
      expect(row.triggers, row.partition).toEqual(['audit_log_append_only', 'audit_log_no_truncate']);
    }
  });

  test('TRUNCATE is refused on every partition, not only on the parent', async ({ db }) => {
    const { rows } = await db.query(`
      SELECT inhrelid::REGCLASS::TEXT AS partition FROM pg_inherits
      WHERE inhparent = 'audit_log'::REGCLASS ORDER BY 1`);
    for (const { partition } of rows) {
      await rolledBack(db, async () => {
        await expect(db.query(`TRUNCATE ${partition}`), partition).rejects.toMatchObject({
          code: 'SH004',
          message: 'audit_log is append-only: TRUNCATE is not allowed',
        });
      });
    }
  });
});
