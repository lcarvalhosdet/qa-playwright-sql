import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';

// Customers and products made for one test, with random SKUs and emails, and
// everything that hangs off them removed when the test ends. For tests that
// commit for real (the db-serial and shop-api projects), so the seed stays as
// it was for the next run.
export class Scratch {
  private products: number[] = [];
  private customers: number[] = [];

  constructor(private db: Client) {}

  async product(stock: number, price = 10): Promise<number> {
    const { rows } = await this.db.query(
      `INSERT INTO products (sku, name, price, stock) VALUES ($1, 'Test item', $2, $3) RETURNING id`,
      [`TS-${randomUUID().slice(0, 8)}`, price, stock],
    );
    this.products.push(rows[0].id);
    return rows[0].id;
  }

  async customer(): Promise<number> {
    const { rows } = await this.db.query(
      `INSERT INTO customers (name, email) VALUES ('Test customer', $1) RETURNING id`,
      [`test-${randomUUID().slice(0, 8)}@example.com`],
    );
    this.customers.push(rows[0].id);
    return rows[0].id;
  }

  async cleanup(): Promise<void> {
    // payments has no ON DELETE CASCADE, so a paid order goes after its payment.
    await this.db.query(
      'DELETE FROM payments WHERE order_id IN (SELECT id FROM orders WHERE customer_id = ANY($1))',
      [this.customers],
    );
    await this.db.query('DELETE FROM orders WHERE customer_id = ANY($1)', [this.customers]); // items by CASCADE
    await this.db.query('DELETE FROM products WHERE id = ANY($1)', [this.products]);
    await this.db.query('DELETE FROM customers WHERE id = ANY($1)', [this.customers]);
  }
}
