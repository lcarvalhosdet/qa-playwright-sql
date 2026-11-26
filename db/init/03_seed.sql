-- 03: seed data that the tests in tests/db rely on.
-- On an empty database the identity columns start at 1, so the ids below are fixed.
--
-- customers  1 Ana, 2 Bruno, 3 Carla (Carla has no orders on purpose)
-- orders     1 Ana PAID 250.00, 2 Ana PENDING 50.00,
--            3 Bruno PAID 900.00, 4 Bruno CANCELLED 150.00

INSERT INTO customers (name, email, city) VALUES
  ('Ana',   'ana@example.com',   'Recife'),
  ('Bruno', 'bruno@example.com', 'Olinda'),
  ('Carla', 'carla@example.com', 'Recife');

INSERT INTO products (sku, name, price, stock) VALUES
  ('KB-01', 'Keyboard',  150.00, 10),
  ('MS-01', 'Mouse',      50.00, 25),
  ('MN-01', 'Monitor',   900.00,  3),
  ('CB-01', 'USB cable',  15.00,  0);  -- out of stock

INSERT INTO orders (customer_id, status) VALUES
  (1, 'PAID'),
  (1, 'PENDING'),
  (2, 'PAID'),
  (2, 'CANCELLED');

-- subtotal is left out: the database computes it.
INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES
  (1, 1, 1, 150.00),  -- Keyboard
  (1, 2, 2,  50.00),  -- 2 Mouse
  (2, 2, 1,  50.00),  -- Mouse
  (3, 3, 1, 900.00),  -- Monitor
  (4, 1, 1, 150.00);  -- Keyboard

INSERT INTO payments (order_id, amount, method) VALUES
  (1, 250.00, 'PIX'),
  (3, 900.00, 'CARD');
