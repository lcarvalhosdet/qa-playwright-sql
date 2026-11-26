-- Queries to run in DBeaver or psql against the seed in db/init/03_seed.sql.
-- Carla has no orders on purpose, to show the difference between the joins.

-- ---------------------------------------------------------------------------
-- Joins
-- ---------------------------------------------------------------------------

-- INNER JOIN across three tables: every item with its customer and product
SELECT c.name AS customer, o.id AS order_id, o.status, p.name AS product, oi.quantity, oi.subtotal
FROM customers c
JOIN orders o       ON o.customer_id = c.id
JOIN order_items oi ON oi.order_id   = o.id
JOIN products p     ON p.id          = oi.product_id
ORDER BY o.id, p.name;                           -- 5 rows, no Carla

-- LEFT JOIN: every customer, with or without orders
SELECT c.name, o.id AS order_id
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id
ORDER BY c.name, o.id;                           -- 5 rows, Carla with a NULL order

-- Anti-join: customers without orders, written two ways
SELECT c.name FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id
WHERE o.id IS NULL;                              -- Carla

SELECT c.name FROM customers c
WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id);  -- Carla

-- ---------------------------------------------------------------------------
-- Aggregation
-- ---------------------------------------------------------------------------

-- The order total comes from its items. COUNT(DISTINCT) avoids counting an
-- order once per item after the JOIN.
SELECT o.id, o.status, COUNT(*) AS items, SUM(oi.subtotal) AS total
FROM orders o
JOIN order_items oi ON oi.order_id = o.id
GROUP BY o.id, o.status
ORDER BY o.id;                                   -- 250.00, 50.00, 900.00, 150.00

-- FILTER aggregates only some rows of each group, without a second query
SELECT c.name,
       COUNT(DISTINCT o.id)                                     AS orders,
       SUM(oi.subtotal)                                         AS all_orders,
       SUM(oi.subtotal) FILTER (WHERE o.status <> 'CANCELLED')  AS revenue,
       SUM(oi.subtotal) FILTER (WHERE o.status = 'PENDING')     AS awaiting_payment
FROM customers c
JOIN orders o       ON o.customer_id = c.id
JOIN order_items oi ON oi.order_id   = o.id
GROUP BY c.id, c.name
HAVING COUNT(DISTINCT o.id) >= 2
ORDER BY revenue DESC;                           -- Bruno 900.00, Ana 300.00

-- Data quality: payments that do not match the order total (should be empty)
SELECT p.order_id, p.amount, SUM(oi.subtotal) AS total
FROM payments p
JOIN order_items oi ON oi.order_id = p.order_id
GROUP BY p.order_id, p.amount
HAVING p.amount <> SUM(oi.subtotal);

-- ---------------------------------------------------------------------------
-- Constraints: each statement below fails. Run them one at a time.
-- ---------------------------------------------------------------------------

UPDATE products SET stock = -1 WHERE sku = 'KB-01';                       -- 23514 products_stock_check
INSERT INTO orders (customer_id, status) VALUES (1, 'SHIPPING');          -- 22P02 not in the ENUM
INSERT INTO customers (name, email) VALUES ('X', 'ANA@example.com');      -- 23505 customers_email_lower_key
UPDATE order_items SET subtotal = 1 WHERE order_id = 1;                   -- 428C9 generated column
DELETE FROM customers WHERE id = 1;                                       -- 23503 ON DELETE RESTRICT

-- ---------------------------------------------------------------------------
-- Indexes and EXPLAIN
-- ---------------------------------------------------------------------------

-- The indexes of a table
SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'orders';

-- With 4 rows the planner picks a Seq Scan: reading the whole table is cheaper
-- than going through an index. Add volume inside a transaction, refresh the
-- statistics and compare the plans. ROLLBACK undoes everything.
BEGIN;
INSERT INTO orders (customer_id, status)
SELECT 3, 'PAID' FROM generate_series(1, 20000);
ANALYZE orders;

-- Index Scan (or Bitmap Index Scan) on orders_customer_id_idx
EXPLAIN ANALYZE SELECT * FROM orders WHERE customer_id = 2;

-- Without the index, for comparison: DROP INDEX is transactional too
DROP INDEX orders_customer_id_idx;
EXPLAIN ANALYZE SELECT * FROM orders WHERE customer_id = 2;  -- Seq Scan over 20,004 rows

-- Partial index: used for PENDING, not for PAID
EXPLAIN SELECT id FROM orders WHERE status = 'PENDING' ORDER BY created_at;
EXPLAIN SELECT id FROM orders WHERE status = 'PAID'    ORDER BY created_at;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Functions (db/init/04_functions.sql)
-- ---------------------------------------------------------------------------

-- Scalar function, called once per row
SELECT id, status, order_total(id) AS total FROM orders ORDER BY id;  -- 250.00, 50.00, 900.00, 150.00

SELECT order_total(999);                         -- fails: P0002 order 999 does not exist

-- IMMUTABLE and STRICT
SELECT apply_discount(250, 10);                  -- 225.00
SELECT apply_discount(9.99, 15);                 -- 8.49 (8.4915 rounded)
SELECT apply_discount(NULL, 10);                 -- NULL, the body never runs
SELECT apply_discount(10, 101);                  -- fails: 22023 with a HINT

-- Named arguments: the order no longer matters
SELECT apply_discount(p_percent => 10, p_amount => 250);  -- 225.00

-- Table function, called in FROM
SELECT * FROM customer_summary(1);               -- Ana: 2 orders, 300.00, 150.00 average

-- LATERAL runs the function once per row of the table on its left
SELECT c.name, s.*
FROM customers c
CROSS JOIN LATERAL customer_summary(c.id) s
ORDER BY s.revenue DESC;                         -- Bruno, Ana, Carla with 0.00

-- Inlining: the SQL function disappears from the plan, which uses the index
-- inside it. A PL/pgSQL function would show up as a "Function Scan".
EXPLAIN SELECT * FROM customer_summary(1);

SELECT can_fulfill(1, 10), can_fulfill(1, 11), can_fulfill(999, 1);  -- true, false, false

-- The volatility of each function: i = IMMUTABLE, s = STABLE, v = VOLATILE
SELECT proname, provolatile, proisstrict, l.lanname
FROM pg_proc p
JOIN pg_language l ON l.oid = p.prolang
WHERE proname IN ('order_total', 'apply_discount', 'customer_summary', 'can_fulfill');

-- Only IMMUTABLE functions can be used in an index
CREATE INDEX ON orders (order_total(id));        -- fails: 42P17

-- BEGIN ATOMIC records what the body uses
ALTER TABLE products DROP COLUMN stock;          -- fails: 2BP01, can_fulfill depends on it

-- Snapshot trap: every part of one statement sees the data as it was when the
-- statement started, so the function does not see the order inserted by the CTE.
BEGIN;
WITH new_order AS (INSERT INTO orders (customer_id) VALUES (3) RETURNING id)
SELECT order_total(id) FROM new_order;           -- fails: order N does not exist
ROLLBACK;
