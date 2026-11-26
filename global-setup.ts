import path from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

// Starts a fresh PostgreSQL 16 for the run with Testcontainers, unless:
//   - DB_URL is set: the tests use that database instead (an existing one, or
//     the docker-compose one for exploring with DBeaver);
//   - only non-database projects were asked for (npm run test:web).
//
// The container gets a random free port, so it never clashes with another
// PostgreSQL on 5432, and runs every file in db/init on start, exactly like
// docker-compose does. Workers read DB_URL from the environment set here.
// The function it returns stops the container when the run ends.
export default async function globalSetup(): Promise<(() => Promise<void>) | void> {
  if (process.env.DB_URL) return;
  if (!databaseProjectsSelected()) return;

  const container = await new PostgreSqlContainer('postgres:16')
    .withDatabase('shop')
    .withUsername('qa')
    .withPassword('qa')
    // mode: the files arrive owned by root, and the init scripts run as the
    // postgres user, which must be able to read them whatever the local mode.
    .withCopyDirectoriesToContainer([
      { source: path.join(__dirname, 'db', 'init'), target: '/docker-entrypoint-initdb.d', mode: 0o755 },
    ])
    .start();

  process.env.DB_URL = container.getConnectionUri();
  console.log(`PostgreSQL started by Testcontainers on port ${container.getPort()}`);

  return async () => {
    await container.stop();
  };
}

// True when the run includes a db project: no --project flag at all, or one
// that starts with "db".
function databaseProjectsSelected(): boolean {
  const args = process.argv;
  const projects = args.flatMap((arg, i) => {
    if (arg.startsWith('--project=')) return [arg.slice('--project='.length)];
    if (arg === '--project' && args[i + 1]) return [args[i + 1]];
    return [];
  });
  return projects.length === 0 || projects.some((name) => name.startsWith('db'));
}
