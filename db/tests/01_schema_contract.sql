-- pgTAP: the schema contract.
--
-- pgTAP is a test framework written in SQL: each assertion is a function that
-- returns one line of TAP ("ok 3 - ..." or "not ok 3 - ..."). It is strongest
-- at describing the schema itself, with one line per fact: this table exists,
-- this column has this type, this function is STABLE, this role has exactly
-- these privileges. tests/db/pgtap.spec.ts runs this file inside a
-- transaction that is rolled back, and reports each line as an assertion.
--
-- The Playwright tests check behavior; this file pins the shape, so a change
-- to the schema has to be made here too, on purpose.

SELECT plan(48);

-- Tables and views
SELECT has_table(t) FROM unnest(ARRAY[
  'customers', 'products', 'categories', 'orders', 'order_items', 'payments',
  'audit_log', 'stock_alerts', 'order_status_transitions', 'schema_migrations'
]) t;
SELECT has_view(v) FROM unnest(ARRAY[
  'order_totals', 'customer_order_history', 'product_sales', 'category_sales', 'revenue_by_city'
]) v;
SELECT has_materialized_view('daily_sales');

-- Types and columns
SELECT enum_has_labels('order_status', ARRAY['PENDING', 'PAID', 'SHIPPED', 'CANCELLED']);
SELECT col_type_is('orders', 'status', 'order_status');
SELECT col_type_is('products', 'price', 'numeric(10,2)');
SELECT col_type_is('order_items', 'subtotal', 'numeric(12,2)');
SELECT col_type_is('audit_log', 'new_data', 'jsonb');

-- Keys
SELECT col_is_pk('orders', 'id');
SELECT col_is_pk('order_items', ARRAY['order_id', 'product_id']);
SELECT fk_ok('orders', 'customer_id', 'customers', 'id');
SELECT fk_ok('order_items', 'order_id', 'orders', 'id');
SELECT fk_ok('order_items', 'product_id', 'products', 'id');
SELECT fk_ok('payments', 'order_id', 'orders', 'id');
SELECT fk_ok('products', 'category_id', 'categories', 'id');

-- Partitioning and indexes
SELECT is_partitioned('audit_log');
SELECT has_index('orders', 'orders_customer_created_idx');
SELECT has_index('orders', 'orders_pending_created_at_idx');
SELECT has_index('customers', 'customers_email_lower_key');
SELECT hasnt_index('orders', 'orders_customer_id_idx', 'the redundant single-column index is gone');

-- Triggers
SELECT trigger_is('orders', 'orders_10_check_status', 'check_status_transition');
SELECT trigger_is('orders', 'orders_audit', 'audit_row');
SELECT trigger_is('products', 'products_stock_alerts', 'raise_stock_alerts');

-- Routines
SELECT volatility_is('order_total', ARRAY['integer'], 'stable');
SELECT volatility_is('apply_discount', ARRAY['numeric', 'numeric'], 'immutable');
SELECT is_procedure('place_order');
SELECT is_definer('place_order');
SELECT isnt_definer('expire_pending_orders', 'the batch job runs as its caller, so it can COMMIT');

-- Roles and privileges
SELECT has_role('shop_api');
SELECT isnt_superuser('shop_api');
SELECT table_privs_are('orders', 'shop_api', ARRAY['SELECT'], 'shop_api only reads orders');
SELECT table_privs_are('audit_log', 'shop_api', ARRAY[]::TEXT[], 'shop_api has no access to the audit log');
SELECT table_privs_are('customers', 'shop_reporting', ARRAY[]::TEXT[], 'reporting cannot read personal data');
SELECT policies_are('orders', ARRAY['api_reads_all', 'customer_reads_own']);

-- Extensions
SELECT has_extension('pg_stat_statements');

SELECT finish();
