-- pgTAP: business rules, written as SQL.
--
-- The same rules the Playwright tests in tests/db check, here in the
-- database's own language, for comparison. throws_ok runs the statement in a
-- savepoint, so a failure does not end the transaction and the next
-- assertion still runs. Everything is rolled back at the end.

SELECT plan(10);

-- Results
SELECT results_eq(
  'SELECT order_total(id) FROM orders ORDER BY id',
  ARRAY[250.00, 50.00, 900.00, 150.00]::NUMERIC[],
  'order_total of each seed order'
);
SELECT results_eq(
  'SELECT c.name::TEXT FROM customers c WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id)',
  ARRAY['Carla'],
  'Carla is the only customer without orders'
);
SELECT is(
  (SELECT revenue FROM category_sales WHERE depth = 0),
  1200.00::NUMERIC,
  'the root category adds up every sale'
);
SELECT is(apply_discount(9.99, 15), 8.49::NUMERIC, '15% off 9.99 rounds to 8.49');

-- Errors, by SQLSTATE and message
SELECT throws_ok(
  $$CALL place_order(1, '[{"product_id": 3, "quantity": 4}]')$$,
  'SH001', 'insufficient stock for product 3',
  'place_order refuses more than the stock'
);
SELECT throws_ok(
  $$UPDATE orders SET status = 'SHIPPED' WHERE id = 2$$,
  'SH002', 'order 2 cannot go from PENDING to SHIPPED',
  'the status trigger refuses a skipped step'
);
SELECT throws_ok('DELETE FROM audit_log', 'SH004', NULL, 'the audit log is append-only');
SELECT throws_ok('SELECT apply_discount(10, 101)', '22023', NULL, 'a discount over 100% is refused');

-- A change and its effect
SELECT lives_ok(
  $$CALL place_order(1, '[{"product_id": 1, "quantity": 1}]')$$,
  'a valid order goes through'
);
SELECT is((SELECT stock FROM products WHERE id = 1), 9, 'and takes one keyboard from the stock');

SELECT finish();
