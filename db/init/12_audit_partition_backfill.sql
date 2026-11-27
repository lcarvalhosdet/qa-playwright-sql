-- 12: move audit history out of the default partition.
--
-- 11_performance.sql created partitions for the current month and the next
-- two only. On a fresh database that is enough. On a database already in use,
-- every older audit row went into audit_log_default, and from then on
-- create_audit_partition() for any of those months fails: PostgreSQL will not
-- create a partition whose range already has rows in the default partition
-- (23514, "updated partition constraint for default partition would be
-- violated"). tests/db/migrations.spec.ts builds a database at version 10
-- with history, migrates it, and shows both the problem and this fix.
--
-- 11 had already been applied, so this is a new migration rather than an edit
-- of 11: a database that ran 11 would never run an edited 11 again, and
-- db/migrate.ts refuses to run a migration whose file changed after it was
-- applied.
--
-- On a database whose default partition is empty, this does nothing.

DO $$
DECLARE
  v_month DATE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM audit_log_default) THEN
    RETURN;
  END IF;

  -- A partition for a month cannot be added while the default partition holds
  -- rows of that month, so take the default partition out first.
  ALTER TABLE audit_log DETACH PARTITION audit_log_default;
  ALTER TABLE audit_log_default RENAME TO audit_log_default_old;

  FOR v_month IN SELECT DISTINCT date_trunc('month', changed_at)::DATE FROM audit_log_default_old LOOP
    PERFORM create_audit_partition(v_month);
  END LOOP;

  -- Every month now has a partition, so each row is routed to its own.
  INSERT INTO audit_log (id, table_name, operation, row_id, old_data, new_data, changed_fields,
                         changed_by, transaction_id, changed_at)
  SELECT id, table_name, operation, row_id, old_data, new_data, changed_fields,
         changed_by, transaction_id, changed_at
  FROM audit_log_default_old;

  DROP TABLE audit_log_default_old;

  -- A new, empty default partition, with its TRUNCATE guard.
  CREATE TABLE audit_log_default PARTITION OF audit_log DEFAULT;
  CREATE TRIGGER audit_log_no_truncate
    BEFORE TRUNCATE ON audit_log_default
    FOR EACH STATEMENT EXECUTE FUNCTION forbid_change('audit_log');
END;
$$;
