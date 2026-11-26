-- 10: security. Who can do what, enforced by the database.
--
-- Until now everything ran as qa, a superuser that can do anything and that
-- ignores row-level security. This file adds three roles with the least
-- privilege each one needs:
--
--   shop_api        LOGIN. The API connects as this role. It can read, and it
--                   can change data only by calling the procedures: no direct
--                   INSERT, UPDATE or DELETE on any table. Every rule in the
--                   procedures and triggers therefore applies to every change.
--   shop_reporting  Reads the report views. No access to the tables, so no
--                   access to personal data such as customer emails.
--   shop_customer   A customer of the shop, for a self-service portal. Sees
--                   only their own orders, items and payments, through
--                   row-level security (RLS).
--
-- The password below is a local test credential, like qa/qa in docker-compose.
--
-- Error code for every refusal here: 42501 insufficient_privilege.

CREATE ROLE shop_api LOGIN PASSWORD 'shop_api';
CREATE ROLE shop_reporting NOLOGIN;
CREATE ROLE shop_customer NOLOGIN;

-- ---------------------------------------------------------------------------
-- 1. Routines: nobody may run them unless granted
-- ---------------------------------------------------------------------------
-- PostgreSQL lets every role (PUBLIC) execute a new function or procedure by
-- default. Take that away, then grant each routine to the role that needs it.
--
-- REVOKE ... ON ALL ROUTINES covers only the routines that exist now. ALTER
-- DEFAULT PRIVILEGES covers the ones this owner creates later, such as
-- current_customer_id() further down; without it, that function would be
-- executable by everyone again.
--
-- It has no IN SCHEMA on purpose: defaults set per schema can only add
-- privileges to the global ones, never take them away, so
-- "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ..." would do nothing here.
-- tests/db/security.spec.ts checks the catalog and caught exactly that.
REVOKE EXECUTE ON ALL ROUTINES IN SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON ROUTINES FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 2. SECURITY DEFINER: the only way in
-- ---------------------------------------------------------------------------
-- A SECURITY DEFINER routine runs with the privileges of its owner (qa), not
-- of the caller. shop_api has no INSERT on orders, but place_order can insert
-- on its behalf, after checking everything it checks.
--
-- SET search_path pins where the routine looks up names. Without it, a caller
-- who can create objects earlier in its search_path could put a fake
-- "products" table or "can_fulfill" function there and run it with the
-- owner's privileges. pg_temp goes last for the same reason.
ALTER PROCEDURE place_order(INTEGER, JSONB, INTEGER) SECURITY DEFINER SET search_path = public, pg_temp;
ALTER PROCEDURE pay_order(INTEGER, VARCHAR) SECURITY DEFINER SET search_path = public, pg_temp;
ALTER PROCEDURE cancel_order(INTEGER) SECURITY DEFINER SET search_path = public, pg_temp;
ALTER FUNCTION update_product_price(INTEGER, NUMERIC, INTEGER) SECURITY DEFINER SET search_path = public, pg_temp;

-- expire_pending_orders stays as it is: a SECURITY DEFINER procedure cannot
-- COMMIT, and the batch job is for the operators (the owner), not the API.

-- ---------------------------------------------------------------------------
-- 3. The audit log cannot be forged
-- ---------------------------------------------------------------------------
-- The audit trigger now runs as the owner too, so no role needs INSERT on
-- audit_log, and no role gets it: nobody can write a fake entry. Together
-- with the append-only triggers from 06, the log can only grow, and only
-- through real changes.
--
-- Inside a SECURITY DEFINER function current_user is the owner, so the old
-- DEFAULT current_user would record qa for everyone. The function records the
-- role that made the change instead: the role set with SET ROLE if any,
-- otherwise the login (session_user), which for the API is shop_api.
CREATE OR REPLACE FUNCTION audit_row()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_old     JSONB;
  v_new     JSONB;
  v_changed TEXT[];
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN v_old := to_jsonb(OLD); END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN v_new := to_jsonb(NEW); END IF;

  IF TG_OP = 'UPDATE' THEN
    SELECT array_agg(n.key ORDER BY n.key) INTO v_changed
    FROM jsonb_each(v_new) AS n
    WHERE n.value IS DISTINCT FROM v_old -> n.key
      AND n.key NOT IN ('updated_at', 'version');

    IF v_changed IS NULL THEN
      RETURN NULL;
    END IF;
  END IF;

  INSERT INTO audit_log (table_name, operation, row_id, old_data, new_data, changed_fields, changed_by)
  VALUES (TG_TABLE_NAME, TG_OP, (coalesce(v_new, v_old) ->> 'id')::int, v_old, v_new, v_changed,
          coalesce(nullif(current_setting('role'), 'none'), session_user));

  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Grants: exactly what each role needs
-- ---------------------------------------------------------------------------
-- shop_api: reads what its routes return, and calls the four write routines.
GRANT SELECT ON customers, products, categories, orders, order_items, payments TO shop_api;
GRANT SELECT ON order_totals, product_sales, category_sales TO shop_api;
GRANT EXECUTE ON PROCEDURE place_order(INTEGER, JSONB, INTEGER), pay_order(INTEGER, VARCHAR),
  cancel_order(INTEGER) TO shop_api;
GRANT EXECUTE ON FUNCTION update_product_price(INTEGER, NUMERIC, INTEGER) TO shop_api;

-- shop_reporting: the report views only.
GRANT SELECT ON product_sales, category_sales, revenue_by_city, daily_sales TO shop_reporting;

-- shop_customer: the catalog, and their own rows of the order tables (RLS below).
GRANT SELECT ON products, categories TO shop_customer;
GRANT SELECT ON customers, orders, order_items, payments, order_totals TO shop_customer;

-- ---------------------------------------------------------------------------
-- 5. Row-level security
-- ---------------------------------------------------------------------------
-- With RLS on, a role sees only the rows a policy lets it see; with no policy
-- for it, it sees nothing. Table owners and superusers are not affected, so
-- every test that runs as qa sees all rows as before.
--
-- Which customer is asking: the application sets it per transaction,
--   SELECT set_config('app.customer_id', '1', true);
-- current_setting(..., true) returns NULL when it was never set, so the
-- policy matches nothing. After a SET LOCAL ends, the same call returns an
-- empty string instead, and ''::int would fail: NULLIF turns it into NULL.
CREATE FUNCTION current_customer_id()
RETURNS INTEGER
LANGUAGE sql
STABLE
BEGIN ATOMIC
  SELECT NULLIF(current_setting('app.customer_id', true), '')::INT;
END;
GRANT EXECUTE ON FUNCTION current_customer_id() TO shop_customer;

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;

-- The API is trusted to read every row; its writes go through the procedures.
CREATE POLICY api_reads_all ON customers FOR SELECT TO shop_api USING (true);
CREATE POLICY api_reads_all ON orders FOR SELECT TO shop_api USING (true);
CREATE POLICY api_reads_all ON order_items FOR SELECT TO shop_api USING (true);
CREATE POLICY api_reads_all ON payments FOR SELECT TO shop_api USING (true);

-- A customer reads their own rows. The items and payments policies look up
-- the order, and that lookup is itself filtered by the orders policy.
CREATE POLICY customer_reads_own ON customers FOR SELECT TO shop_customer
  USING (id = current_customer_id());
CREATE POLICY customer_reads_own ON orders FOR SELECT TO shop_customer
  USING (customer_id = current_customer_id());
CREATE POLICY customer_reads_own ON order_items FOR SELECT TO shop_customer
  USING (EXISTS (SELECT 1 FROM orders o WHERE o.id = order_items.order_id));
CREATE POLICY customer_reads_own ON payments FOR SELECT TO shop_customer
  USING (EXISTS (SELECT 1 FROM orders o WHERE o.id = payments.order_id));

-- ---------------------------------------------------------------------------
-- 6. Views and RLS
-- ---------------------------------------------------------------------------
-- By default a view reads its tables with the privileges of the view's owner.
-- The owner here is a superuser, which ignores RLS, so a customer granted a
-- plain view over orders would see every customer's orders: RLS on the table
-- does nothing through such a view. security_invoker (PostgreSQL 15+) makes
-- the view read as the caller, so the caller's policies apply.
ALTER VIEW order_totals SET (security_invoker = true);

-- The other views stay as they are: they aggregate across customers on
-- purpose, and only shop_reporting and shop_api can read them.
