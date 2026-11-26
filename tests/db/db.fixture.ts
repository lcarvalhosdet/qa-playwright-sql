import { test as base } from '@playwright/test';
import { Client } from 'pg';

// One PostgreSQL connection per worker, shared by the tests that run in it.
export const test = base.extend<{}, { db: Client }>({
  db: [
    async ({}, use) => {
      const db = new Client({
        connectionString: process.env.DB_URL ?? 'postgresql://qa:qa@localhost:5432/shop',
      });
      await db.connect();
      await use(db);
      await db.end();
    },
    { scope: 'worker' },
  ],
});

export { expect } from '@playwright/test';
