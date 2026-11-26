-- 06: triggers.
--
-- A trigger runs a function automatically when a table changes. Choices:
--
--   timing     BEFORE  runs before the row is written; can change NEW or cancel
--                      the write by raising an error
--              AFTER   runs after the write; sees the final row; used for side
--                      effects such as an audit log
--   level      FOR EACH ROW        once per changed row, with OLD and NEW
--              FOR EACH STATEMENT  once per statement, even if it changed 0 or
--                                  10,000 rows; can see every changed row
--                                  through transition tables
--   condition  WHEN (...)  skips the function when false, cheaper than an IF
--                          inside it
--
-- Several triggers with the same timing on the same table fire in name order,
-- so the names below carry a number: orders_10_... runs before orders_20_....
--
-- Inside a trigger function: NEW and OLD (NULL when they do not apply),
-- TG_OP ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'), TG_TABLE_NAME.
--
-- New custom SQLSTATEs (see 05_procedures.sql for SH001 and SH002):
--   SH003  order without items       SH004  append-only table
--
-- This file also shows how a schema evolves: the new columns come from
-- ALTER TABLE, as a migration would add them to a database already in use.

ALTER TABLE products
  ADD COLUMN updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN reorder_level INTEGER     NOT NULL DEFAULT 2 CHECK (reorder_level >= 0);

ALTER TABLE orders
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- ---------------------------------------------------------------------------
-- 1. updated_at: BEFORE UPDATE, changes NEW
-- ---------------------------------------------------------------------------
-- One generic function, attached to two tables.
CREATE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- now() is the start time of the transaction, so every row changed in one
  -- transaction gets the same value. clock_timestamp() would be the wall clock.
  NEW.updated_at := now();
  RETURN NEW;  -- a BEFORE ROW trigger writes whatever row it returns
END;
$$;

-- WHEN skips updates that change nothing, such as SET price = price.
CREATE TRIGGER orders_20_set_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER products_20_set_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Status rules: BEFORE UPDATE OF status, rejects the write
-- ---------------------------------------------------------------------------
-- The procedures already check the status, but a plain UPDATE does not go
-- through them. The trigger enforces the rule for every client.
-- The allowed moves live in a table, so changing the rule is an INSERT, not
-- a new version of the function.
CREATE TABLE order_status_transitions (
  from_status order_status NOT NULL,
  to_status   order_status NOT NULL,
  PRIMARY KEY (from_status, to_status)
);

INSERT INTO order_status_transitions (from_status, to_status) VALUES
  ('PENDING', 'PAID'),
  ('PENDING', 'CANCELLED'),
  ('PAID',    'SHIPPED'),
  ('PAID',    'CANCELLED');

CREATE FUNCTION check_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM order_status_transitions
    WHERE from_status = OLD.status
      AND to_status   = NEW.status
  ) THEN
    RAISE EXCEPTION 'order % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'SH002';
  END IF;
  RETURN NEW;
END;
$$;

-- UPDATE OF status: fires only when the statement sets that column.
-- Named 10 so it rejects a bad change before updated_at (20) does any work.
CREATE TRIGGER orders_10_check_status
  BEFORE UPDATE OF status ON orders
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION check_status_transition();

-- ---------------------------------------------------------------------------
-- 3. Audit log: AFTER INSERT OR UPDATE OR DELETE
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_name     TEXT        NOT NULL,
  operation      TEXT        NOT NULL,
  row_id         INTEGER     NOT NULL,
  old_data       JSONB,                 -- the row before; NULL for INSERT
  new_data       JSONB,                 -- the row after; NULL for DELETE
  changed_fields TEXT[],                -- UPDATE only
  changed_by     TEXT        NOT NULL DEFAULT current_user,
  -- The transaction that made the change, to group the rows of one operation.
  transaction_id BIGINT      NOT NULL DEFAULT txid_current(),
  changed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_row_idx ON audit_log (table_name, row_id);

CREATE FUNCTION audit_row()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_old     JSONB;
  v_new     JSONB;
  v_changed TEXT[];
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN v_old := to_jsonb(OLD); END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN v_new := to_jsonb(NEW); END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Compare the two rows as JSON, key by key. updated_at always changes,
    -- so it is left out of the list.
    SELECT array_agg(n.key ORDER BY n.key) INTO v_changed
    FROM jsonb_each(v_new) AS n
    WHERE n.value IS DISTINCT FROM v_old -> n.key
      AND n.key <> 'updated_at';

    IF v_changed IS NULL THEN
      RETURN NULL;  -- nothing changed, nothing to log
    END IF;
  END IF;

  INSERT INTO audit_log (table_name, operation, row_id, old_data, new_data, changed_fields)
  VALUES (TG_TABLE_NAME, TG_OP, (coalesce(v_new, v_old) ->> 'id')::int, v_old, v_new, v_changed);

  RETURN NULL;  -- the return value of an AFTER trigger is ignored
END;
$$;

CREATE TRIGGER orders_audit
  AFTER INSERT OR UPDATE OR DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION audit_row();

CREATE TRIGGER products_audit
  AFTER INSERT OR UPDATE OR DELETE ON products
  FOR EACH ROW EXECUTE FUNCTION audit_row();

CREATE TRIGGER payments_audit
  AFTER INSERT OR UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION audit_row();

-- ---------------------------------------------------------------------------
-- 4. Append-only: an audit log nobody can rewrite
-- ---------------------------------------------------------------------------
CREATE FUNCTION forbid_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'SH004';
END;
$$;

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- TRUNCATE skips row triggers, so it needs a statement trigger of its own.
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------------------
-- 5. Stock alerts: FOR EACH STATEMENT with transition tables
-- ---------------------------------------------------------------------------
-- REFERENCING exposes every row the statement changed as two tables, old_rows
-- and new_rows. The function runs once and handles them with one set-based
-- INSERT, instead of once per row. (Transition tables cannot be combined with
-- UPDATE OF column, so this trigger fires on every UPDATE of products.)
CREATE TABLE stock_alerts (
  id            BIGINT  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id    INTEGER NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  stock         INTEGER NOT NULL,
  reorder_level INTEGER NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE FUNCTION raise_stock_alerts()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only products that crossed the line in this statement: above the reorder
  -- level before, at or below it now. A product already below does not alert again.
  INSERT INTO stock_alerts (product_id, stock, reorder_level)
  SELECT n.id, n.stock, n.reorder_level
  FROM new_rows n
  JOIN old_rows o ON o.id = n.id
  WHERE o.stock >  o.reorder_level
    AND n.stock <= n.reorder_level;

  RETURN NULL;
END;
$$;

CREATE TRIGGER products_stock_alerts
  AFTER UPDATE ON products
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION raise_stock_alerts();

-- ---------------------------------------------------------------------------
-- 6. Deferred constraint trigger: a rule checked at COMMIT
-- ---------------------------------------------------------------------------
-- "Every order has at least one item" cannot be a CHECK: it spans two tables,
-- and the order must exist before its items can reference it. A constraint
-- trigger declared INITIALLY DEFERRED waits until COMMIT, when the items are
-- in place. place_order inserts the order and its items in one transaction,
-- so it passes; an order committed without items fails.
--
-- SET CONSTRAINTS orders_must_have_items IMMEDIATE runs the pending checks
-- right away, which is how a test sees the error without committing.
--
-- Limit: it checks new orders only. Deleting the last item of an existing
-- order would need the same trigger on order_items.
CREATE FUNCTION check_order_has_items()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- By COMMIT the order may have been deleted in the same transaction.
  IF EXISTS (SELECT 1 FROM orders WHERE id = NEW.id)
     AND NOT EXISTS (SELECT 1 FROM order_items WHERE order_id = NEW.id) THEN
    RAISE EXCEPTION 'order % has no items', NEW.id
      USING ERRCODE = 'SH003';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER orders_must_have_items
  AFTER INSERT ON orders
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION check_order_has_items();
