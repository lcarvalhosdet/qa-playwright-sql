import { test as base } from '@playwright/test';
import { Client } from 'pg';

// Set by global-setup.ts (Testcontainers) or by whoever runs the tests.
export const DB_URL = process.env.DB_URL ?? 'postgresql://qa:qa@localhost:5432/shop';

// One PostgreSQL connection per worker, shared by the tests that run in it.
export const test = base.extend<object, { db: Client }>({
  db: [
    async ({}, use) => {
      const db = new Client({ connectionString: DB_URL });
      await db.connect();
      await use(db);
      await db.end();
    },
    { scope: 'worker' },
  ],
});

// Runs `fn` inside a transaction that is always rolled back, so a test can
// write to the database without changing the seed for the other tests.
export async function rolledBack<T>(db: Client, fn: () => Promise<T>): Promise<T> {
  await db.query('BEGIN');
  try {
    return await fn();
  } finally {
    await db.query('ROLLBACK');
  }
}

export { expect } from '@playwright/test';
