import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
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
      name: 'db',
      testDir: './tests/db',
      testIgnore: /\.commit\.spec\.ts$/,
    },
    {
      // Tests that COMMIT for real. They start only after every "db" test has
      // finished, so the rolled-back tests never see their data.
      name: 'db-commit',
      testDir: './tests/db',
      testMatch: /\.commit\.spec\.ts$/,
      dependencies: ['db'],
      workers: 1, // committed data is visible to every connection, so one at a time
    },
  ],
});
