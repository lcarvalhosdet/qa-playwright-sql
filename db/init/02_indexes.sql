-- 02: indexes.
-- PostgreSQL creates an index for every PRIMARY KEY and UNIQUE constraint,
-- but not for foreign keys. Without these, a JOIN or a lookup by customer
-- reads the whole table.

-- B-tree index on a foreign key: speeds up "orders of customer X" and the JOINs.
CREATE INDEX orders_customer_id_idx ON orders (customer_id);

-- order_items already has (order_id, product_id) from its primary key,
-- which serves lookups by order_id. Lookups by product need their own index.
CREATE INDEX order_items_product_id_idx ON order_items (product_id);

-- Expression index: unique on lower(email), so 'ana@example.com' and
-- 'ANA@example.com' count as the same address.
CREATE UNIQUE INDEX customers_email_lower_key ON customers (lower(email));

-- Partial index: covers only the PENDING orders, the ones a job checks often.
-- It is smaller than a full index and is used only when the query filters
-- on the same condition (WHERE status = 'PENDING').
CREATE INDEX orders_pending_created_at_idx ON orders (created_at) WHERE status = 'PENDING';
