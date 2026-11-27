-- 11: performance. Indexes shaped for the queries that run most, an index
-- built for an append-only table, and partitioning for a table that only grows.
--
-- The seed is too small for any of this to show: with a handful of rows the
-- planner reads whole tables, which is the right choice. tests/perf runs the
-- same schema in a second database, shop_perf, filled by db/perf/volume.sql
-- with hundreds of thousands of rows, and checks the plans and the work each
-- query does there.

-- pg_stat_statements records every statement the server runs, normalized
-- (literals become $1, $2...), with calls, time and buffers. The server must
-- load it at start (shared_preload_libraries), which docker-compose.yml and
-- global-setup.ts do.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- ---------------------------------------------------------------------------
-- 1. A composite covering index for "a customer's latest orders"
-- ---------------------------------------------------------------------------
-- The most common read: one customer's orders, newest first, a page at a time.
--   SELECT id, status, created_at FROM orders
--   WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 10
--
-- (customer_id, created_at DESC) returns the rows already in that order, so
-- there is no Sort and the LIMIT stops after 10 entries. INCLUDE (id, status)
-- stores the other selected columns in the index too, without making them
-- part of the key, so the whole query is answered from the index (Index Only
-- Scan) without visiting the table.
--
-- For a customer with ten orders the planner may still prefer a bitmap scan
-- and a sort, which is just as cheap at that size. The index pays off for a
-- customer with thousands of orders, which the performance tests include.
CREATE INDEX orders_customer_created_idx ON orders (customer_id, created_at DESC) INCLUDE (id, status);

-- The new index starts with customer_id, so it also serves every lookup the
-- single-column foreign key index from 02_indexes.sql served. Keeping both
-- would double the write cost for no read benefit: a redundant index.
-- tests/db/schema.spec.ts has a catalog check that fails on one.
DROP INDEX orders_customer_id_idx;

-- ---------------------------------------------------------------------------
-- 2. Foreign keys added after phase 1 get their index too
-- ---------------------------------------------------------------------------
-- 02_indexes.sql indexed the foreign keys that existed then. categories and
-- stock_alerts came later without one. A catalog test now checks every
-- foreign key, so a new one cannot be forgotten again.
CREATE INDEX categories_parent_id_idx ON categories (parent_id);
CREATE INDEX stock_alerts_product_id_idx ON stock_alerts (product_id);

-- ---------------------------------------------------------------------------
-- 3. audit_log, partitioned by month
-- ---------------------------------------------------------------------------
-- audit_log only grows: one row for every change to orders, products and
-- payments. Splitting it into one table per month (partitions) under a
-- single parent gives:
--   - partition pruning: a query for one month reads only that month's table;
--   - cheap retention: dropping a month is DROP TABLE, instantly, instead of a
--     DELETE that scans and then leaves dead rows for VACUUM;
--   - smaller indexes per partition.
--
-- A table cannot be turned into a partitioned one in place, so this migration
-- builds the new table, copies the rows and swaps the names, in one
-- transaction (the init scripts run each file as one).
ALTER TABLE audit_log RENAME TO audit_log_unpartitioned;

-- PostgreSQL 16 does not allow identity columns on partitioned tables (17
-- does), so the id comes from a sequence. Its name differs from
-- audit_log_id_seq, which still belongs to the renamed old table until it is
-- dropped. The primary key must include the partition key, changed_at.
CREATE SEQUENCE audit_log_seq;

CREATE TABLE audit_log (
  id             BIGINT      NOT NULL DEFAULT nextval('audit_log_seq'),
  table_name     TEXT        NOT NULL,
  operation      TEXT        NOT NULL,
  row_id         INTEGER     NOT NULL,
  old_data       JSONB,
  new_data       JSONB,
  changed_fields TEXT[],
  changed_by     TEXT        NOT NULL DEFAULT current_user,
  transaction_id BIGINT      NOT NULL DEFAULT txid_current(),
  changed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, changed_at)
) PARTITION BY RANGE (changed_at);

ALTER SEQUENCE audit_log_seq OWNED BY audit_log.id;

-- Rows outside every monthly partition land here instead of failing.
CREATE TABLE audit_log_default PARTITION OF audit_log DEFAULT;

-- An index created on the parent is created on every partition, now and later.
CREATE INDEX audit_log_row_idx_p ON audit_log (table_name, row_id);

-- BRIN (block range index) stores only the minimum and maximum of each range of
-- table pages. In an append-only table changed_at grows with the physical
-- order of the rows, so those ranges are tight and the index is tiny: a few
-- pages where a B-tree needs thousands. It suits "everything between two
-- dates", not "this exact row".
CREATE INDEX audit_log_changed_at_brin ON audit_log USING brin (changed_at);

-- Append-only, as in 06_triggers.sql. Row triggers on the parent are copied
-- to every partition. Statement triggers are not, and TRUNCATE can name a
-- partition directly, so create_audit_partition() adds the TRUNCATE trigger
-- to each partition too. The argument names the table in the error message,
-- because inside a partition's trigger TG_TABLE_NAME is the partition.
CREATE OR REPLACE FUNCTION forbid_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', coalesce(TG_ARGV[0], TG_TABLE_NAME), TG_OP
    USING ERRCODE = 'SH004';
END;
$$;

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_change('audit_log');

CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change('audit_log');

CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log_default
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change('audit_log');

-- Creates the partition for the month that contains p_day, if missing.
-- A scheduler (cron, pg_cron) would call it ahead of each new month; rows
-- for a month without a partition still land safely in audit_log_default.
CREATE FUNCTION create_audit_partition(p_day DATE)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v_start DATE := date_trunc('month', p_day)::DATE;
  v_name  TEXT := format('audit_log_%s', to_char(v_start, 'YYYY_MM'));
BEGIN
  IF to_regclass(v_name) IS NULL THEN
    -- format() with %I quotes the identifier; %L quotes the literal.
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF audit_log FOR VALUES FROM (%L) TO (%L)',
      v_name, v_start, (v_start + INTERVAL '1 month')::DATE
    );
    EXECUTE format(
      'CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON %I '
      'FOR EACH STATEMENT EXECUTE FUNCTION forbid_change(%L)',
      v_name, 'audit_log'
    );
  END IF;
  RETURN v_name;
END;
$$;

-- The current month and the next two.
SELECT create_audit_partition((date_trunc('month', now()) + make_interval(months => g.n))::DATE) AS partition
FROM generate_series(0, 2) g(n);

-- Copy the history, continue the ids after it, and drop the old table (its
-- triggers and index go with it).
-- The columns are listed: SELECT * would depend on both tables having them
-- in the same order.
INSERT INTO audit_log (id, table_name, operation, row_id, old_data, new_data, changed_fields,
                       changed_by, transaction_id, changed_at)
SELECT id, table_name, operation, row_id, old_data, new_data, changed_fields,
       changed_by, transaction_id, changed_at
FROM audit_log_unpartitioned;
SELECT setval('audit_log_seq', COALESCE((SELECT MAX(id) FROM audit_log), 0) + 1, false);
DROP TABLE audit_log_unpartitioned;
