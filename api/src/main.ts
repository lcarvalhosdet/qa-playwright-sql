import { buildApp } from './app.ts';

// Standalone server, for trying the API by hand (curl, Postman, Bruno):
//   docker compose up -d && npm run api
// The tests do not use this file: global-setup.ts starts the API itself.
// It connects as shop_api, the least-privilege role from 10_security.sql.
const databaseUrl = process.env.API_DB_URL ?? 'postgresql://shop_api:shop_api@localhost:5432/shop';
const port = Number(process.env.PORT ?? 3000);

async function main(): Promise<void> {
  const app = buildApp(databaseUrl);
  await app.listen({ port, host: '127.0.0.1' });
  console.log(`Shop API on http://127.0.0.1:${port}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
