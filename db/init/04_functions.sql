-- 04: functions.
--
-- A function takes arguments, returns a value (or a table) and is called inside
-- a query: SELECT order_total(1). It runs inside the caller's transaction and
-- cannot COMMIT. A procedure (phase 3) is called with CALL and can.
--
-- Three things to decide for every function:
--
-- 1. Language
--    sql      a single query. The planner can inline it into the calling query,
--             as if you had written the SQL there yourself.
--    plpgsql  variables, IF, loops and RAISE. Never inlined: it runs as a black box.
--
-- 2. Volatility, a promise to the planner
--    IMMUTABLE  same arguments, same result, forever; reads no tables.
--               Only these can be used in an index or a generated column.
--    STABLE     same result within one statement; may read tables.
--    VOLATILE   anything else (the default), e.g. random() or a function that writes.
--    A wrong promise does not fail; it returns wrong results, e.g. an index built
--    from a function marked IMMUTABLE that actually reads a table.
--
-- 3. NULL handling
--    STRICT  if any argument is NULL, the result is NULL and the body never runs.
--
-- Parameters start with p_ so they never clash with a column of the same name.

-- ---------------------------------------------------------------------------
-- order_total: scalar function in PL/pgSQL with validation
-- ---------------------------------------------------------------------------
CREATE FUNCTION order_total(p_order_id INTEGER)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE      -- reads order_items, so it cannot be IMMUTABLE
STRICT
AS $$
DECLARE
  v_total NUMERIC;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM orders WHERE id = p_order_id) THEN
    -- ERRCODE sets the SQLSTATE the caller sees: P0002 is no_data_found.
    RAISE EXCEPTION 'order % does not exist', p_order_id
      USING ERRCODE = 'no_data_found';
  END IF;

  SELECT SUM(subtotal) INTO v_total
  FROM order_items
  WHERE order_id = p_order_id;

  -- SUM over zero rows is NULL, not 0. ROUND keeps two decimals: 0.00.
  RETURN ROUND(COALESCE(v_total, 0), 2);
END;
$$;

-- ---------------------------------------------------------------------------
-- apply_discount: IMMUTABLE and STRICT, a pure calculation
-- ---------------------------------------------------------------------------
CREATE FUNCTION apply_discount(p_amount NUMERIC, p_percent NUMERIC)
RETURNS NUMERIC
LANGUAGE plpgsql
IMMUTABLE   -- depends only on its arguments
STRICT      -- apply_discount(NULL, 10) is NULL without running the body
AS $$
BEGIN
  IF p_percent < 0 OR p_percent > 100 THEN
    RAISE EXCEPTION 'discount must be between 0 and 100, got %', p_percent
      USING ERRCODE = 'invalid_parameter_value',  -- 22023
            HINT    = 'Pass the percentage as a number, e.g. 15 for 15%.';
  END IF;

  RETURN ROUND(p_amount * (100 - p_percent) / 100, 2);
END;
$$;

-- ---------------------------------------------------------------------------
-- customer_summary: SQL function that returns a table
-- ---------------------------------------------------------------------------
-- RETURNS TABLE declares the output columns. Call it in FROM, like a table:
--   SELECT * FROM customer_summary(1);
-- or once per customer with LATERAL (see sql/queries.sql).
CREATE FUNCTION customer_summary(p_customer_id INTEGER)
RETURNS TABLE (orders INTEGER, cancelled INTEGER, revenue NUMERIC, avg_ticket NUMERIC)
LANGUAGE sql
STABLE
AS $$
  WITH totals AS (
    SELECT o.id, o.status, SUM(oi.subtotal) AS total
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    WHERE o.customer_id = p_customer_id
    GROUP BY o.id, o.status
  )
  -- An aggregate without GROUP BY always returns one row, even for a customer
  -- without orders: 0 orders, 0.00 revenue and a NULL average.
  SELECT COUNT(*)::int,
         (COUNT(*) FILTER (WHERE status = 'CANCELLED'))::int,
         ROUND(COALESCE(SUM(total) FILTER (WHERE status <> 'CANCELLED'), 0), 2),
         ROUND(AVG(total) FILTER (WHERE status <> 'CANCELLED'), 2)
  FROM totals;
$$;

-- ---------------------------------------------------------------------------
-- can_fulfill: SQL-standard body (BEGIN ATOMIC, PostgreSQL 14+)
-- ---------------------------------------------------------------------------
-- A body in quotes ($$ ... $$) is only text until the function runs, so a typo
-- in a column name shows up at the first call. A BEGIN ATOMIC body is parsed
-- when the function is created, and PostgreSQL records which tables and
-- columns it uses: ALTER TABLE products DROP COLUMN stock now fails (2BP01)
-- while this function exists.
-- The procedure in phase 3 uses it before taking stock.
CREATE FUNCTION can_fulfill(p_product_id INTEGER, p_quantity INTEGER)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
STRICT
BEGIN ATOMIC
  -- An unknown product returns no row, which COALESCE turns into false.
  SELECT COALESCE((SELECT stock >= p_quantity FROM products WHERE id = p_product_id), false);
END;
