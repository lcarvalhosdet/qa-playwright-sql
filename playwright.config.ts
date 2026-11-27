import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // Starts PostgreSQL with Testcontainers when DB_URL is not set.
  globalSetup: './global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'ui',
      testDir: './tests/ui',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: process.env.UI_URL ?? 'https://www.saucedemo.com',
        testIdAttribute: 'data-test', // saucedemo tags its elements with data-test
      },
    },
    {
      name: 'api',
      testDir: './tests/api',
      use: { baseURL: process.env.API_URL ?? 'https://jsonplaceholder.typicode.com' },
    },
    {
      // Plans and buffer budgets on a database with volume (shop_perf), which
      // global-setup.ts creates and fills. One worker: a test drops an index
      // inside a transaction, which would make other tests wait.
      name: 'perf',
      testDir: './tests/perf',
      workers: 1,
    },
    {
      // Pure functions, such as the retry helper: no browser, database or API.
      name: 'unit',
      testDir: './tests/unit',
    },
    {
      name: 'db',
      testDir: './tests/db',
      testIgnore: /\.serial\.spec\.ts$/,
    },
    {
      // Tests that COMMIT for real or hold locks across connections. They
      // start only after every "db" test has finished and run one at a time,
      // so no other test sees their data or waits on their locks.
      name: 'db-serial',
      testDir: './tests/db',
      testMatch: /\.serial\.spec\.ts$/,
      dependencies: ['db'],
      workers: 1,
    },
    {
      // End-to-end: the shop API (api/src) over HTTP, then the database.
      // global-setup.ts starts the API. The API commits, so this runs after
      // the other database tests, on data each test creates. After db-serial
      // too: the race test briefly locks audit_log as a barrier, which would
      // make the lock-timing tests there wait.
      name: 'shop-api',
      testDir: './tests/shop-api',
      dependencies: ['db-serial'],
    },
  ],
});
