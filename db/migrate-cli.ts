import path from 'node:path';
import { migrate } from './migrate.ts';

// npm run migrate [-- --to 10_security]
// Applies the pending migrations in db/init to DB_URL (the docker-compose
// database by default).
const databaseUrl = process.env.DB_URL ?? 'postgresql://qa:qa@localhost:5432/shop';
const toIndex = process.argv.indexOf('--to');
const to = toIndex > -1 ? process.argv[toIndex + 1] : undefined;

// npm runs scripts from the project root.
migrate(databaseUrl, { dir: path.join(process.cwd(), 'db', 'init'), to, log: (message) => console.log(message) })
  .then(({ applied, skipped }) => {
    console.log(`${applied.length} applied, ${skipped.length} already there`);
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
