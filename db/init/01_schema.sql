-- Runs automatically the first time the container starts (see docker-compose.yml)
CREATE TABLE customers (
  id   INTEGER PRIMARY KEY,
  name VARCHAR(50) NOT NULL,
  city VARCHAR(50)
);

CREATE TABLE orders (
  id          INTEGER PRIMARY KEY,
  customer_id INTEGER REFERENCES customers (id),
  amount      NUMERIC(10,2) NOT NULL,
  status      VARCHAR(20) NOT NULL
);

INSERT INTO customers (id, name, city) VALUES
  (1, 'Ana',   'Recife'),
  (2, 'Bruno', 'Olinda'),
  (3, 'Carla', 'Recife');

INSERT INTO orders (id, customer_id, amount, status) VALUES
  (10, 1, 100.00, 'PAID'),
  (11, 1,  50.00, 'PENDING'),
  (12, 2,  30.00, 'PAID'),
  (13, 2,  20.00, 'CANCELLED');
