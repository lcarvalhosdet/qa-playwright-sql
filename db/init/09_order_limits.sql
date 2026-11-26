-- 09: a limit on open orders, and why it needs SERIALIZABLE plus retries.
--
-- Rule: a customer can have at most max_pending_orders orders waiting for
-- payment (PENDING) at a time, to stop a client from reserving stock with
-- orders it never pays.
--
-- The check counts rows, and a count is a read of a set, not of one row. Two
-- transactions that insert an order for the same customer at the same time
-- each count the orders committed before they started, both see room for one
-- more, and both insert: the limit is broken. This is the write skew from
-- 08_concurrency.sql, now in a real rule. Row locks do not help, because the
-- row that would conflict does not exist yet.
--
-- Two ways to make the check exact:
--   1. lock the customer row (SELECT ... FROM customers ... FOR UPDATE) before
--      counting, so orders for one customer are placed one at a time;
--   2. run the transaction as SERIALIZABLE: PostgreSQL detects that the two
--      transactions read what the other wrote and fails one with 40001, which
--      the caller retries.
-- The shop API uses option 2 (api/src/retry.ts), to show the retry pattern
-- that SERIALIZABLE requires. Option 1 is simpler when one rule is the only
-- concern; option 2 protects every rule that reads sets, with no extra locks.
--
-- Under READ COMMITTED, the default, the trigger below can let the limit be
-- exceeded by concurrent inserts. tests/db/concurrency.serial.spec.ts shows it.
--
-- New custom SQLSTATE: SH006 too many pending orders.

ALTER TABLE customers
  ADD COLUMN max_pending_orders INTEGER NOT NULL DEFAULT 10 CHECK (max_pending_orders > 0);

CREATE FUNCTION check_pending_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_limit   INTEGER;
  v_pending INTEGER;
BEGIN
  SELECT max_pending_orders INTO v_limit FROM customers WHERE id = NEW.customer_id;

  SELECT COUNT(*) INTO v_pending
  FROM orders
  WHERE customer_id = NEW.customer_id
    AND status = 'PENDING';

  IF v_pending >= v_limit THEN
    RAISE EXCEPTION 'customer % already has % pending orders', NEW.customer_id, v_pending
      USING ERRCODE = 'SH006',
            DETAIL  = format('the limit is %s', v_limit),
            HINT    = 'Pay or cancel a pending order first.';
  END IF;
  RETURN NEW;
END;
$$;

-- Only new PENDING orders count against the limit; orders created as PAID or
-- CANCELLED (imports, test data) do not.
CREATE TRIGGER orders_05_check_pending_limit
  BEFORE INSERT ON orders
  FOR EACH ROW
  WHEN (NEW.status = 'PENDING')
  EXECUTE FUNCTION check_pending_limit();
