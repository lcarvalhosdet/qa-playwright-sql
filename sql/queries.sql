-- Queries to run in DBeaver or psql against the seed in db/init/01_schema.sql
-- Carla has no orders on purpose, to show the difference between the joins.

-- WHERE filters, ORDER BY sorts, AS renames
SELECT name AS customer, city
FROM customers
WHERE city = 'Recife'
ORDER BY name;                                   -- Ana, Carla

-- INNER JOIN: only customers that have orders
SELECT c.name, o.id AS order_id, o.amount
FROM customers c
JOIN orders o ON o.customer_id = c.id
ORDER BY o.amount DESC;                          -- 4 rows, no Carla

-- LEFT JOIN: every customer, with or without orders
SELECT c.name, o.id AS order_id
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id
ORDER BY c.name, o.id;                           -- 5 rows, Carla with a NULL order

-- RIGHT JOIN: the same result with the tables swapped
SELECT c.name, o.id AS order_id
FROM orders o
RIGHT JOIN customers c ON o.customer_id = c.id
ORDER BY c.name, o.id;

-- Customers without orders
SELECT c.name
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id
WHERE o.id IS NULL;                              -- Carla

-- GROUP BY groups, HAVING filters the groups
SELECT c.name, COUNT(o.id) AS orders, SUM(o.amount) AS total
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id
GROUP BY c.id, c.name
HAVING COUNT(o.id) >= 2
ORDER BY total DESC;                             -- Ana 2 / 150.00, Bruno 2 / 50.00

-- UPDATE and DELETE inside a transaction, so running this file changes nothing
BEGIN;
DELETE FROM orders WHERE status = 'CANCELLED';   -- removes order 13
UPDATE orders SET status = 'PAID' WHERE id = 11;
SELECT * FROM orders ORDER BY id;                -- 10, 11 and 12, all PAID
ROLLBACK;
