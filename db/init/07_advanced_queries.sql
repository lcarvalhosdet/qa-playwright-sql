-- 07: advanced queries, packaged as views so the tests can check them.
--
--   categories            a tree: each category points to its parent
--   category_tree         recursive CTE, top-down, with depth and path
--   category_ancestors()  recursive CTE, bottom-up, with the CYCLE clause
--   category_sales        recursive closure table: revenue including subcategories
--   order_totals          plain view: one row per order with its total
--   customer_order_history  window functions: ROW_NUMBER, running total, LAG
--   product_sales         ranking: ROW_NUMBER vs RANK vs DENSE_RANK, share of total
--   revenue_by_city       GROUP BY ROLLUP with GROUPING() for subtotals
--   daily_sales           materialized view with a 7-day moving window (RANGE)
--   import_products()     UPSERT: INSERT ... ON CONFLICT DO UPDATE
--
-- "Revenue" is every order that is not CANCELLED, as in the earlier tests.
--
-- Dates are taken in the shop's time zone, America/Recife (UTC-3). An order at
-- 23:30 in Recife is already the next day in UTC, so created_at::date alone
-- would put it on the wrong day.

-- ---------------------------------------------------------------------------
-- Categories: a tree stored as an adjacency list (parent_id)
-- ---------------------------------------------------------------------------
CREATE TABLE categories (
  id        INTEGER     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name      VARCHAR(50) NOT NULL UNIQUE,
  parent_id INTEGER     REFERENCES categories (id),  -- NULL for a root
  CHECK (parent_id <> id)                            -- not its own parent
);

-- Electronics
-- ├── Computers
-- │   ├── Peripherals
-- │   │   ├── Keyboards
-- │   │   └── Mice
-- │   └── Monitors
-- └── Accessories
--     └── Cables
INSERT INTO categories (name) VALUES ('Electronics');
INSERT INTO categories (name, parent_id)
SELECT child, (SELECT id FROM categories WHERE name = parent)
FROM (VALUES ('Computers', 'Electronics'), ('Accessories', 'Electronics')) AS v(child, parent);
INSERT INTO categories (name, parent_id)
SELECT child, (SELECT id FROM categories WHERE name = parent)
FROM (VALUES ('Peripherals', 'Computers'), ('Monitors', 'Computers'), ('Cables', 'Accessories')) AS v(child, parent);
INSERT INTO categories (name, parent_id)
SELECT child, (SELECT id FROM categories WHERE name = parent)
FROM (VALUES ('Keyboards', 'Peripherals'), ('Mice', 'Peripherals')) AS v(child, parent);

ALTER TABLE products ADD COLUMN category_id INTEGER REFERENCES categories (id);
CREATE INDEX products_category_id_idx ON products (category_id);

UPDATE products p
SET category_id = c.id
FROM (VALUES ('KB-01', 'Keyboards'), ('MS-01', 'Mice'), ('MN-01', 'Monitors'), ('CB-01', 'Cables')) AS v(sku, category)
JOIN categories c ON c.name = v.category
WHERE p.sku = v.sku;

-- ---------------------------------------------------------------------------
-- Recursive CTEs
-- ---------------------------------------------------------------------------
-- WITH RECURSIVE has two parts joined by UNION ALL:
--   the anchor     runs once (here: the roots)
--   the recursive  runs again and again on the rows the previous step added,
--                  until a step adds none
CREATE VIEW category_tree AS
WITH RECURSIVE tree AS (
  SELECT id, name, parent_id, 0 AS depth, name::text AS path
  FROM categories
  WHERE parent_id IS NULL

  UNION ALL

  SELECT c.id, c.name, c.parent_id, t.depth + 1, t.path || ' > ' || c.name
  FROM categories c
  JOIN tree t ON c.parent_id = t.id
)
SELECT id, name, parent_id, depth, path FROM tree;

-- Walking up from a category to the root. If bad data made a loop
-- (A -> B -> A), a recursive CTE would run forever. The CYCLE clause
-- (PostgreSQL 14+) keeps the ids already visited, marks the row that repeats
-- one with is_cycle = true and stops there.
CREATE FUNCTION category_ancestors(p_category_id INTEGER)
RETURNS TABLE (id INTEGER, name VARCHAR, distance INTEGER)
LANGUAGE sql
STABLE
AS $$
  WITH RECURSIVE up AS (
    SELECT c.id, c.name, c.parent_id, 0 AS distance
    FROM categories c
    WHERE c.id = p_category_id

    UNION ALL

    SELECT parent.id, parent.name, parent.parent_id, up.distance + 1
    FROM categories parent
    JOIN up ON parent.id = up.parent_id
  ) CYCLE id SET is_cycle USING visited
  SELECT id, name, distance
  FROM up
  WHERE distance > 0 AND NOT is_cycle
  ORDER BY distance;
$$;

-- ---------------------------------------------------------------------------
-- order_totals: a plain view
-- ---------------------------------------------------------------------------
-- A view is a saved query. It stores no data: every SELECT on it runs the
-- query again, so it is always current.
--
-- GROUP BY o.id lets the SELECT use any other column of orders: o.id is the
-- primary key, so PostgreSQL knows each group has one order.
CREATE VIEW order_totals AS
SELECT o.id                                          AS order_id,
       o.customer_id,
       c.name                                        AS customer,
       o.status,
       o.created_at,
       (o.created_at AT TIME ZONE 'America/Recife')::date AS order_date,
       COUNT(oi.product_id)::int                     AS items,
       COALESCE(SUM(oi.subtotal), 0)::numeric(12,2)  AS total
FROM orders o
JOIN customers c         ON c.id = o.customer_id
LEFT JOIN order_items oi ON oi.order_id = o.id
GROUP BY o.id, c.name;

-- ---------------------------------------------------------------------------
-- Window functions
-- ---------------------------------------------------------------------------
-- A window function computes over a set of rows related to the current one,
-- without collapsing them like GROUP BY does: every order stays a row.
--   PARTITION BY  splits the rows into groups (here: one per customer)
--   ORDER BY      orders the rows inside each group
--   frame         which rows of the group count for the current row
--
-- The default frame with ORDER BY is RANGE ... CURRENT ROW, which includes
-- every row tied with the current one. ROWS counts physical rows instead, so
-- the running total grows one order at a time even when two orders tie.
CREATE VIEW customer_order_history AS
SELECT customer_id,
       customer,
       order_id,
       order_date,
       total,
       ROW_NUMBER() OVER w ::int                                            AS order_number,
       SUM(total)   OVER (w ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_total,
       order_date - LAG(order_date) OVER w                                  AS days_since_previous,
       ROUND(total / NULLIF(SUM(total) OVER (PARTITION BY customer_id), 0), 2) AS share_of_customer
FROM order_totals
WHERE status <> 'CANCELLED'
WINDOW w AS (PARTITION BY customer_id ORDER BY created_at, order_id);

-- Three ways to number rows ordered by revenue, which differ only on ties:
--   ROW_NUMBER  1, 2, 3, 4  always distinct; ties broken by the next ORDER BY key
--   RANK        1, 2, 2, 4  ties share a rank, then the numbering skips
--   DENSE_RANK  1, 2, 2, 3  ties share a rank, no gap
-- SUM(...) OVER () with an empty window is the total over every row.
CREATE VIEW product_sales AS
WITH sold AS (
  SELECT oi.product_id, SUM(oi.quantity) AS units, SUM(oi.subtotal) AS revenue
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  WHERE o.status <> 'CANCELLED'
  GROUP BY oi.product_id
),
per_product AS (
  -- LEFT JOIN keeps the products that never sold, with 0.
  SELECT p.id AS product_id, p.sku, p.name, p.category_id,
         COALESCE(s.units, 0)::int              AS units,
         COALESCE(s.revenue, 0)::numeric(12,2)  AS revenue
  FROM products p
  LEFT JOIN sold s ON s.product_id = p.id
)
SELECT product_id, sku, name, category_id, units, revenue,
       ROW_NUMBER() OVER (ORDER BY revenue DESC, sku)::int AS row_number,
       RANK()       OVER (ORDER BY revenue DESC)::int      AS rank,
       DENSE_RANK() OVER (ORDER BY revenue DESC)::int      AS dense_rank,
       ROUND(100 * revenue / NULLIF(SUM(revenue) OVER (), 0), 1) AS pct_of_revenue
FROM per_product;

-- Revenue per category including every subcategory below it. The recursive
-- CTE builds a closure table: one row per (ancestor, descendant) pair,
-- including each category with itself. Joining sales to it adds every sale to
-- the category and to all its ancestors.
CREATE VIEW category_sales AS
WITH RECURSIVE closure AS (
  SELECT id AS ancestor_id, id AS category_id
  FROM categories

  UNION ALL

  SELECT cl.ancestor_id, c.id
  FROM closure cl
  JOIN categories c ON c.parent_id = cl.category_id
)
SELECT t.id,
       t.path,
       t.depth,
       COUNT(ps.product_id)::int                  AS products,
       COALESCE(SUM(ps.units), 0)::int            AS units,
       COALESCE(SUM(ps.revenue), 0)::numeric(12,2) AS revenue
FROM category_tree t
JOIN closure cl          ON cl.ancestor_id = t.id
LEFT JOIN product_sales ps ON ps.category_id = cl.category_id
GROUP BY t.id, t.path, t.depth;

-- ---------------------------------------------------------------------------
-- ROLLUP: detail rows plus subtotals in one query
-- ---------------------------------------------------------------------------
-- GROUP BY ROLLUP (city, customer) produces the groups
--   (city, customer)   one row per customer
--   (city)             a subtotal per city
--   ()                 the grand total
-- In a subtotal row the rolled-up column is NULL. GROUPING() says whether a
-- NULL means "subtotal" (1) or a real NULL value, such as a customer without a
-- city (0). With two columns it returns a bitmask: 0 detail, 1 city subtotal,
-- 3 grand total.
CREATE VIEW revenue_by_city AS
SELECT CASE WHEN GROUPING(c.city) = 1 THEN 'All cities'    ELSE c.city END AS city,
       CASE WHEN GROUPING(c.name) = 1 THEN 'All customers' ELSE c.name END AS customer,
       SUM(ot.total)::numeric(12,2) AS revenue,
       GROUPING(c.city, c.name)     AS level
FROM order_totals ot
JOIN customers c ON c.id = ot.customer_id
WHERE ot.status <> 'CANCELLED'
GROUP BY ROLLUP (c.city, c.name);

-- ---------------------------------------------------------------------------
-- Materialized view: a stored result, refreshed on demand
-- ---------------------------------------------------------------------------
-- Unlike a view, a materialized view keeps its rows. Reading it is as fast as
-- reading a table, but it shows the data as of the last
--   REFRESH MATERIALIZED VIEW daily_sales;
-- A plain REFRESH blocks readers until it ends. REFRESH ... CONCURRENTLY lets
-- them keep reading the old rows, and needs a UNIQUE index to match old and
-- new rows.
--
-- SUM(SUM(total)) OVER: the inner SUM is the GROUP BY aggregate (revenue of
-- the day); the outer one is a window over those daily rows. RANGE with an
-- interval covers the days within 6 days before the current one, so a day
-- without orders does not shift the window, as ROWS 6 PRECEDING would.
CREATE MATERIALIZED VIEW daily_sales AS
SELECT order_date                 AS day,
       COUNT(*)::int              AS orders,
       SUM(total)::numeric(12,2)  AS revenue,
       ROUND(AVG(total), 2)       AS avg_ticket,
       SUM(SUM(total)) OVER (
         ORDER BY order_date
         RANGE BETWEEN INTERVAL '6 days' PRECEDING AND CURRENT ROW
       )::numeric(12,2)           AS revenue_7d
FROM order_totals
WHERE status <> 'CANCELLED'
GROUP BY order_date;

CREATE UNIQUE INDEX daily_sales_day_key ON daily_sales (day);

-- ---------------------------------------------------------------------------
-- UPSERT: insert new rows, update the ones that already exist
-- ---------------------------------------------------------------------------
-- A supplier feed: [{"sku": "...", "name": "...", "price": 10, "received": 5}]
-- New SKUs are inserted; known SKUs get the new name and price, and the
-- received quantity is added to the stock. Returns what happened to each SKU.
--
--   ON CONFLICT (...) DO UPDATE  runs the UPDATE instead of failing on the
--                                unique constraint
--   EXCLUDED                     the row that was proposed for insertion
--   WHERE on DO UPDATE           skips rows where nothing would change; they
--                                are not returned
--   xmax = 0                     true for a row this statement inserted. xmax is
--                                an internal column; this is a known trick, not
--                                an official API.
-- The whole feed is one statement: if any row fails, nothing is imported.
CREATE FUNCTION import_products(p_feed JSONB)
RETURNS TABLE (sku VARCHAR, action TEXT)
LANGUAGE plpgsql
VOLATILE  -- it writes, so it must be VOLATILE (the default)
AS $$
-- The output column "sku" has the same name as products.sku. This tells
-- PL/pgSQL that a bare "sku" in the query means the table column.
#variable_conflict use_column
BEGIN
  RETURN QUERY
  INSERT INTO products AS p (sku, name, price, stock)
  SELECT f.sku, f.name, f.price, COALESCE(f.received, 0)
  FROM jsonb_to_recordset(p_feed) AS f(sku VARCHAR, name VARCHAR, price NUMERIC, received INTEGER)
  ON CONFLICT ON CONSTRAINT products_sku_key DO UPDATE
    SET name  = EXCLUDED.name,
        price = EXCLUDED.price,
        stock = p.stock + EXCLUDED.stock
    WHERE (p.name, p.price) IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.price)
       OR EXCLUDED.stock > 0
  RETURNING p.sku, CASE WHEN p.xmax = 0 THEN 'inserted' ELSE 'updated' END;
END;
$$;
