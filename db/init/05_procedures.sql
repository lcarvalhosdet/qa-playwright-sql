-- 05: procedures.
--
-- Function vs procedure in PostgreSQL ("stored procedure" is CREATE PROCEDURE):
--
--                       FUNCTION                      PROCEDURE
--   called with         SELECT f(...), inside a query  CALL p(...), on its own
--   returns             a value or a table             nothing; INOUT/OUT parameters
--                                                      come back as one row
--   COMMIT / ROLLBACK   never                          yes, when CALL is not inside
--                                                      an explicit BEGIN block
--   typical use         calculations, lookups          business operations that
--                                                      change several tables
--
-- Atomicity: one CALL is one statement. If anything inside it fails, every
-- change it made is undone, unless the procedure committed before the error.
--
-- Errors use SQLSTATE codes so callers (and tests) can tell them apart:
--   P0002  no_data_found            unknown customer, product or order
--   22023  invalid_parameter_value  malformed input
--   SH001  insufficient stock       (custom code, class SH = shop)
--   SH002  invalid status change    (custom code)
-- A custom SQLSTATE is any five digits or uppercase letters outside the
-- classes PostgreSQL uses.
--
-- Locking: before changing stock, each procedure locks the product rows with
-- SELECT ... FOR UPDATE, always in id order. Two transactions that lock the
-- same rows in the same order wait for each other; in opposite orders they can
-- deadlock. Phase 6 tests this with concurrent connections.

-- ---------------------------------------------------------------------------
-- place_order: validates, locks, writes three tables, returns the new id
-- ---------------------------------------------------------------------------
--   CALL place_order(1, '[{"product_id": 1, "quantity": 2}]');
-- returns one row with p_order_id.
CREATE PROCEDURE place_order(
  p_customer_id    INTEGER,
  p_items          JSONB,
  INOUT p_order_id INTEGER DEFAULT NULL
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_item       RECORD;
  v_stock      INTEGER;
  v_constraint TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM customers WHERE id = p_customer_id) THEN
    RAISE EXCEPTION 'customer % does not exist', p_customer_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Two IFs, because SQL does not promise to evaluate the left side of OR
  -- first, and jsonb_array_length fails on anything that is not an array.
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'items must be a JSON array' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'an order needs at least one item' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Lock every product of the order, in id order, before reading any stock.
  PERFORM 1
  FROM products
  WHERE id IN (SELECT (item ->> 'product_id')::int FROM jsonb_array_elements(p_items) AS item)
  ORDER BY id
  FOR UPDATE;

  INSERT INTO orders (customer_id) VALUES (p_customer_id)
  RETURNING id INTO p_order_id;

  -- jsonb_to_recordset turns the JSON array into rows with typed columns.
  FOR v_item IN
    SELECT product_id, quantity
    FROM jsonb_to_recordset(p_items) AS item(product_id INTEGER, quantity INTEGER)
  LOOP
    IF v_item.quantity IS NULL OR v_item.quantity <= 0 THEN
      RAISE EXCEPTION 'quantity must be positive, got %', coalesce(v_item.quantity::text, 'NULL')
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    SELECT stock INTO v_stock FROM products WHERE id = v_item.product_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'product % does not exist', v_item.product_id
        USING ERRCODE = 'no_data_found';
    END IF;

    -- The function from phase 2. The row is locked, so the stock cannot
    -- change between this check and the UPDATE below.
    IF NOT can_fulfill(v_item.product_id, v_item.quantity) THEN
      RAISE EXCEPTION 'insufficient stock for product %', v_item.product_id
        USING ERRCODE = 'SH001',
              DETAIL  = format('requested %s, in stock %s', v_item.quantity, v_stock);
    END IF;

    -- unit_price is copied from the current price.
    INSERT INTO order_items (order_id, product_id, quantity, unit_price)
    SELECT p_order_id, id, v_item.quantity, price
    FROM products
    WHERE id = v_item.product_id;

    UPDATE products SET stock = stock - v_item.quantity WHERE id = v_item.product_id;
  END LOOP;

-- An EXCEPTION clause catches errors raised in the block above. PostgreSQL
-- opens a savepoint when the block starts, so catching costs a little; use it
-- to translate an error, not to hide it.
EXCEPTION
  WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'order_items_pkey' THEN
      RAISE EXCEPTION 'a product appears more than once in the order'
        USING ERRCODE = 'invalid_parameter_value',
              HINT    = 'Send each product once with the total quantity.';
    END IF;
    RAISE;  -- any other unique violation goes up unchanged
END;
$$;

-- ---------------------------------------------------------------------------
-- pay_order: PENDING -> PAID, charging the total from order_total
-- ---------------------------------------------------------------------------
CREATE PROCEDURE pay_order(p_order_id INTEGER, p_method VARCHAR)
LANGUAGE plpgsql
AS $$
DECLARE
  v_status order_status;
BEGIN
  -- FOR UPDATE: two payments for the same order cannot both read PENDING.
  SELECT status INTO v_status FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order % does not exist', p_order_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_status <> 'PENDING' THEN
    RAISE EXCEPTION 'order % is % and cannot be paid', p_order_id, v_status
      USING ERRCODE = 'SH002';
  END IF;

  -- The CHECK on payments.method rejects an unknown method (23514).
  INSERT INTO payments (order_id, amount, method)
  VALUES (p_order_id, order_total(p_order_id), p_method);

  UPDATE orders SET status = 'PAID' WHERE id = p_order_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- cancel_order: PENDING or PAID -> CANCELLED, returning the items to stock
-- ---------------------------------------------------------------------------
-- Refunds are out of scope: a paid order keeps its payment row.
CREATE PROCEDURE cancel_order(p_order_id INTEGER)
LANGUAGE plpgsql
AS $$
DECLARE
  v_status order_status;
BEGIN
  SELECT status INTO v_status FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order % does not exist', p_order_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_status NOT IN ('PENDING', 'PAID') THEN
    RAISE EXCEPTION 'order % is % and cannot be cancelled', p_order_id, v_status
      USING ERRCODE = 'SH002';
  END IF;

  PERFORM 1
  FROM products
  WHERE id IN (SELECT product_id FROM order_items WHERE order_id = p_order_id)
  ORDER BY id
  FOR UPDATE;

  -- UPDATE ... FROM joins another table into the UPDATE.
  UPDATE products p
  SET stock = p.stock + oi.quantity
  FROM order_items oi
  WHERE oi.order_id = p_order_id
    AND p.id = oi.product_id;

  UPDATE orders SET status = 'CANCELLED' WHERE id = p_order_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- expire_pending_orders: a batch job with COMMIT inside
-- ---------------------------------------------------------------------------
-- Cancels the PENDING orders created before a cutoff, p_batch_size at a time,
-- committing after each batch. On a large table this keeps each transaction
-- short, holds the row locks briefly, and keeps the finished batches if the
-- job stops halfway.
--
-- COMMIT works only when the CALL is not inside BEGIN ... COMMIT. Inside one,
-- the first COMMIT fails with 2D000 invalid_transaction_termination.
--
--   CALL expire_pending_orders(now() - interval '7 days');
CREATE PROCEDURE expire_pending_orders(
  p_created_before TIMESTAMPTZ,
  p_batch_size     INTEGER DEFAULT 100,
  INOUT p_expired  INTEGER DEFAULT 0
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_ids INTEGER[];
  v_id  INTEGER;
BEGIN
  IF p_batch_size IS NULL OR p_batch_size < 1 THEN
    RAISE EXCEPTION 'batch size must be at least 1' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  p_expired := 0;
  LOOP
    -- FOR UPDATE SKIP LOCKED: lock the batch, and skip rows another run of
    -- this job has already locked. Without it, two runs at the same time pick
    -- the same orders and the second fails with "order N is CANCELLED".
    -- A row that changed status after this statement started is re-checked
    -- against the WHERE before it is locked, so it is left out.
    SELECT array_agg(id) INTO v_ids
    FROM (
      SELECT id
      FROM orders
      WHERE status = 'PENDING'
        AND created_at < p_created_before
      ORDER BY id
      LIMIT p_batch_size
      FOR UPDATE SKIP LOCKED
    ) AS batch;

    EXIT WHEN v_ids IS NULL;  -- array_agg over zero rows is NULL

    FOREACH v_id IN ARRAY v_ids LOOP
      CALL cancel_order(v_id);  -- a procedure can CALL another one
    END LOOP;

    p_expired := p_expired + cardinality(v_ids);
    RAISE NOTICE 'expired % orders, % so far', cardinality(v_ids), p_expired;

    COMMIT;  -- variables such as p_expired survive the COMMIT
  END LOOP;
END;
$$;
