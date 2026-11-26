-- 01: tables and constraints.
-- The files in db/init run in name order the first time the container starts
-- (see docker-compose.yml), and CI runs them in the same order.

-- An ENUM limits a column to a fixed list of values; anything else fails with 22P02.
CREATE TYPE order_status AS ENUM ('PENDING', 'PAID', 'SHIPPED', 'CANCELLED');

CREATE TABLE customers (
  -- GENERATED ALWAYS AS IDENTITY: the database picks the id, and an INSERT
  -- that tries to set it fails unless it says OVERRIDING SYSTEM VALUE.
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       VARCHAR(50)  NOT NULL,
  email      VARCHAR(100) NOT NULL,  -- unique ignoring case, see 02_indexes.sql
  city       VARCHAR(50),
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id    INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sku   VARCHAR(20)   NOT NULL UNIQUE,
  name  VARCHAR(100)  NOT NULL,
  price NUMERIC(10,2) NOT NULL CHECK (price > 0),
  -- The CHECK is the last line of defense: no bug in the app can sell stock it does not have.
  stock INTEGER       NOT NULL DEFAULT 0 CHECK (stock >= 0)
);

CREATE TABLE orders (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- ON DELETE RESTRICT: a customer with orders cannot be deleted.
  customer_id INTEGER      NOT NULL REFERENCES customers (id) ON DELETE RESTRICT,
  status      order_status NOT NULL DEFAULT 'PENDING',
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
  -- ON DELETE CASCADE: deleting an order deletes its items with it.
  order_id   INTEGER       NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product_id INTEGER       NOT NULL REFERENCES products (id),
  quantity   INTEGER       NOT NULL CHECK (quantity > 0),
  -- The price is copied at purchase time, so a later price change
  -- does not rewrite the value of old orders.
  unit_price NUMERIC(10,2) NOT NULL CHECK (unit_price > 0),
  -- A generated column is computed by the database and cannot be written.
  subtotal   NUMERIC(12,2) GENERATED ALWAYS AS (quantity * unit_price) STORED,
  -- Composite primary key: the same product appears once per order.
  PRIMARY KEY (order_id, product_id)
);

CREATE TABLE payments (
  id       INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id INTEGER       NOT NULL UNIQUE REFERENCES orders (id),  -- one payment per order
  amount   NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  method   VARCHAR(10)   NOT NULL CHECK (method IN ('CARD', 'PIX', 'BOLETO')),
  paid_at  TIMESTAMPTZ   NOT NULL DEFAULT now()
);
