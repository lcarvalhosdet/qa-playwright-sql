-- 08: concurrency.
--
-- Most of this phase lives in the tests (tests/db/concurrency.serial.spec.ts),
-- which open several connections and interleave their transactions. This file
-- adds the two pieces that need database objects: optimistic locking and an
-- advisory lock.
--
-- Isolation levels in PostgreSQL, and what each one allows:
--
--   READ COMMITTED (default)  each statement sees the data committed before
--                             it started. Two reads in one transaction can
--                             differ (non-repeatable read).
--   REPEATABLE READ           the whole transaction sees one snapshot, taken
--                             at its first query. Updating a row that another
--                             transaction changed since then fails with 40001.
--   SERIALIZABLE              as REPEATABLE READ, plus it detects transactions
--                             that read what the other wrote (write skew) and
--                             fails one of them with 40001.
--
-- 40001 (serialization_failure) and 40P01 (deadlock_detected) mean "retry":
-- the transaction did nothing wrong, it lost a race. An application should
-- run it again from the start.
--
-- Ways to keep two writers from losing each other's update:
--   atomic UPDATE   SET stock = stock - 1, computed by the database
--   pessimistic     SELECT ... FOR UPDATE, then write (place_order does this)
--   optimistic      write only if the row still has the version you read
--   isolation       REPEATABLE READ or SERIALIZABLE, and retry on 40001
--
-- New custom SQLSTATE: SH005 the row changed since it was read.

-- ---------------------------------------------------------------------------
-- Optimistic locking: a version number on products
-- ---------------------------------------------------------------------------
-- Pessimistic locking holds a lock while the user looks at a form, which can
-- be minutes. Optimistic locking holds none: the client reads the row and its
-- version, and the UPDATE succeeds only if the version is still the same.
-- If someone else saved first, the client gets SH005 and reloads.
ALTER TABLE products ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

-- Every real change bumps the version, whoever makes it: the price form,
-- place_order taking stock, the import. Named 30 to run after updated_at (20).
CREATE FUNCTION bump_version()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER products_30_bump_version
  BEFORE UPDATE ON products
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION bump_version();

-- Returns the new version, to send with the next change.
CREATE FUNCTION update_product_price(p_product_id INTEGER, p_price NUMERIC, p_expected_version INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_version INTEGER;
BEGIN
  -- The version check is in the WHERE, so the check and the write are one
  -- atomic statement: there is no gap between them for another writer.
  UPDATE products
  SET price = p_price
  WHERE id = p_product_id
    AND version = p_expected_version
  RETURNING version INTO v_version;

  IF FOUND THEN
    RETURN v_version;
  END IF;

  SELECT version INTO v_version FROM products WHERE id = p_product_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'product % does not exist', p_product_id USING ERRCODE = 'no_data_found';
  END IF;
  RAISE EXCEPTION 'product % was changed by someone else', p_product_id
    USING ERRCODE = 'SH005',
          DETAIL  = format('expected version %s, current version %s', p_expected_version, v_version),
          HINT    = 'Read the product again and repeat the change.';
END;
$$;

-- ---------------------------------------------------------------------------
-- Advisory lock: one refresh at a time
-- ---------------------------------------------------------------------------
-- An advisory lock locks a number, not a row. The application decides what the
-- number means; here, "the daily_sales refresh". hashtext turns a name into
-- that number.
--
--   pg_advisory_xact_lock      waits for the lock
--   pg_try_advisory_xact_lock  returns false at once if someone holds it
-- The _xact_ versions release the lock when the transaction ends.
--
-- Returns true if it refreshed, false if another session was already doing it.
CREATE FUNCTION refresh_daily_sales()
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('refresh daily_sales')) THEN
    RETURN false;
  END IF;

  REFRESH MATERIALIZED VIEW CONCURRENTLY daily_sales;
  RETURN true;
END;
$$;
