import { request, type APIRequestContext } from '@playwright/test';
import { test as base } from '../db/db.fixture';
import { Scratch } from '../db/scratch';

// End-to-end tests of the shop API (api/src): each test calls the API over
// HTTP and then checks the database directly with the worker's db connection.
//
// The API commits for real, so these tests run in their own project after the
// "db" tests, and work only on customers and products they create (scratch),
// removed when each test ends.
export const test = base.extend<{ api: APIRequestContext; scratch: Scratch }>({
  api: async ({}, use) => {
    const baseURL = process.env.SHOP_API_URL;
    if (!baseURL) throw new Error('SHOP_API_URL is not set: global-setup.ts starts the API for the shop-api project');
    const api = await request.newContext({ baseURL });
    await use(api);
    await api.dispose();
  },
  scratch: async ({ db }, use) => {
    const scratch = new Scratch(db);
    await use(scratch);
    await scratch.cleanup();
  },
});

export { expect } from '@playwright/test';
