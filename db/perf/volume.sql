-- Volume for the performance tests (tests/perf), loaded into shop_perf, a copy
-- of the shop database made by global-setup.ts. Never loaded into shop: the
-- other tests rely on its small, known seed.
--
--   20,000 customers, 2,000 products, 200,000 orders over the last 12 months,
--   plus one wholesale customer with 5,000 orders of their own,
--   about 500,000 order items, a payment for every paid or shipped order, and
--   one audit row per order, in time order.
--
-- setseed makes random() repeat the same sequence, so every run builds the
-- same data and the tests see the same plans.
--
-- Each INSERT ... SELECT names its expressions after the target columns.

-- Bulk load without triggers or foreign key checks (both are triggers inside
-- PostgreSQL): the audit trigger alone would write 700,000 rows, one by one.
-- Only a superuser can do this, and only because the data below is
-- consistent by construction: every order has items, every reference exists.
SET session_replication_role = replica;
SELECT setseed(0.42);

INSERT INTO customers (name, email, city)
SELECT 'Customer ' || g.n AS name,
       'customer' || g.n || '@perf.example.com' AS email,
       (ARRAY['Recife', 'Olinda', 'Natal', 'Fortaleza', 'Salvador'])[1 + g.n % 5] AS city
FROM generate_series(1, 20000) g(n);

-- One customer who buys far more than the rest: the case where an index that
-- returns rows already sorted makes a difference.
INSERT INTO customers (name, email, city, max_pending_orders)
VALUES ('Wholesale buyer', 'wholesale@perf.example.com', 'Recife', 10000);

INSERT INTO products (sku, name, price, stock, category_id)
SELECT 'P-' || lpad(g.n::TEXT, 5, '0') AS sku,
       'Product ' || g.n AS name,
       round((5 + random() * 995)::NUMERIC, 2) AS price,
       1000 AS stock,
       c.id AS category_id
FROM generate_series(1, 2000) g(n)
JOIN categories c ON c.name = (ARRAY['Keyboards', 'Mice', 'Monitors', 'Cables'])[1 + g.n % 4];

-- Statistics after each bulk insert that the next statement reads. Until
-- ANALYZE runs, the planner still believes these tables hold the few rows of
-- the seed, and it once planned the order_items INSERT below as a nested loop
-- that rebuilt the 2,000-product list for each of 205,000 orders: 19 seconds
-- instead of under one. Autovacuum would analyze them eventually, but not in
-- time for the next statement.
ANALYZE customers, products;

-- Status mix: 60% paid, 15% shipped, 15% cancelled, 10% pending.
WITH perf_customers AS (
  SELECT array_agg(id ORDER BY id) AS ids FROM customers WHERE email LIKE '%@perf.example.com'
)

INSERT INTO orders (customer_id, status, created_at)
SELECT pc.ids[1 + floor(random() * array_length(pc.ids, 1))::INT] AS customer_id,
       (CASE
          WHEN s.r < 0.60 THEN 'PAID'
          WHEN s.r < 0.75 THEN 'SHIPPED'
          WHEN s.r < 0.90 THEN 'CANCELLED'
          ELSE 'PENDING'
        END)::order_status AS status,
       now() - random() * INTERVAL '365 days' AS created_at
FROM (SELECT random() AS r FROM generate_series(1, 200000)) s
CROSS JOIN perf_customers pc;

INSERT INTO orders (customer_id, status, created_at)
SELECT c.id AS customer_id,
       (CASE WHEN random() < 0.9 THEN 'PAID' ELSE 'PENDING' END)::order_status AS status,
       now() - random() * INTERVAL '365 days' AS created_at
FROM customers c
CROSS JOIN generate_series(1, 5000)
WHERE c.email = 'wholesale@perf.example.com';

ANALYZE orders;

-- 1 to 4 distinct products per order (2.5 on average). Steps of 523 over
-- 2,000 products never land on the same product twice within 4 steps.
WITH perf_products AS (
  SELECT array_agg(id ORDER BY id) AS ids, array_agg(price ORDER BY id) AS prices
  FROM products
  WHERE sku LIKE 'P-%'
)

INSERT INTO order_items (order_id, product_id, quantity, unit_price)
SELECT o.id AS order_id,
       pp.ids[1 + (o.id + g.n * 523) % 2000] AS product_id,
       1 + (o.id + g.n) % 3 AS quantity,
       pp.prices[1 + (o.id + g.n * 523) % 2000] AS unit_price
FROM orders o
CROSS JOIN perf_products pp
CROSS JOIN LATERAL generate_series(1, 1 + o.id % 4) g(n)
WHERE o.customer_id IN (SELECT c.id FROM customers c WHERE c.email LIKE '%@perf.example.com');

ANALYZE order_items;

INSERT INTO payments (order_id, amount, method, paid_at)
SELECT o.id AS order_id,
       SUM(oi.subtotal) AS amount,
       (ARRAY['CARD', 'PIX', 'BOLETO'])[1 + o.id % 3] AS method,
       o.created_at + INTERVAL '1 hour' AS paid_at
FROM orders o
JOIN order_items oi ON oi.order_id = o.id
WHERE o.status IN ('PAID', 'SHIPPED')
  AND o.customer_id IN (SELECT c.id FROM customers c WHERE c.email LIKE '%@perf.example.com')
GROUP BY o.id, o.created_at;

-- A monthly partition for each of the last 12 months, then the audit rows in
-- time order, as an append-only log grows.
SELECT create_audit_partition((now() - make_interval(months => g.n))::DATE) AS partition
FROM generate_series(1, 12) g(n);

INSERT INTO audit_log (table_name, operation, row_id, new_data, changed_by, changed_at)
SELECT 'orders' AS table_name,
       'INSERT' AS operation,
       o.id AS row_id,
       jsonb_build_object('id', o.id, 'customer_id', o.customer_id, 'status', o.status) AS new_data,
       'perf-load' AS changed_by,
       o.created_at AS changed_at
FROM orders o
WHERE o.customer_id IN (SELECT c.id FROM customers c WHERE c.email LIKE '%@perf.example.com')
ORDER BY o.created_at;

RESET session_replication_role;
