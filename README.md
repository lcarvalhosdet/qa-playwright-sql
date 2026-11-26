# QA automation with Playwright and SQL

[![tests](https://github.com/lcarvalhosdet/qa-playwright-sql/actions/workflows/tests.yml/badge.svg)](https://github.com/lcarvalhosdet/qa-playwright-sql/actions/workflows/tests.yml)

UI, API and database tests in one small Playwright project, written in TypeScript and run on every push with GitHub Actions.

## What it tests

| Layer | Target | Tests |
| --- | --- | --- |
| UI | [Sauce Demo](https://www.saucedemo.com) | login and add to cart, locked-out user error, sort by price |
| API | [JSONPlaceholder](https://jsonplaceholder.typicode.com) | GET a post, POST a post, 404 for a missing post |
| Database | PostgreSQL 16 in Docker | queries (joins, GROUP BY with FILTER and HAVING, data-quality checks), constraints (CHECK, UNIQUE, ENUM, generated and identity columns, foreign keys with RESTRICT and CASCADE) and index usage read from `EXPLAIN` |

## Database

A small e-commerce schema: `customers`, `products`, `orders`, `order_items` and `payments`. The SQL files in `db/init` run in name order:

| File | What it has |
| --- | --- |
| `01_schema.sql` | tables, an `order_status` ENUM, `CHECK` rules (no negative stock, known payment methods), identity keys, a generated `subtotal` column, foreign keys with `ON DELETE RESTRICT` and `CASCADE` |
| `02_indexes.sql` | indexes on the foreign keys, an expression index for case-insensitive unique emails, a partial index for pending orders |
| `03_seed.sql` | the data the tests rely on |

The constraint tests check the SQLSTATE code and the constraint name rather than the error text, and every write runs in a transaction that is rolled back. The index tests add 20,000 rows inside a transaction, run `ANALYZE` and assert on the plan from `EXPLAIN (FORMAT JSON)`.

## Run it

Requirements: Node.js 20 or newer and Docker.

```bash
npm ci
npx playwright install chromium
docker compose up -d     # PostgreSQL with the seed in db/init
npm test                 # all tests
npm run test:web         # UI and API only, no database needed
npm run test:db          # database only
npm run report           # open the HTML report
```

The scripts in `db/init` run only when the database is created. After changing them, recreate it:

```bash
docker compose down -v && docker compose up -d
```

If port 5432 is taken, map another port in `docker-compose.yml` and point the tests at it with `DB_URL=postgresql://qa:qa@localhost:5433/shop`.

## Structure

```text
pages/login-page.ts          page object for the login screen
tests/ui/                    UI tests (Sauce Demo)
tests/api/                   API tests (JSONPlaceholder)
tests/db/orders.spec.ts      queries and data-quality checks
tests/db/schema.spec.ts      constraints and index usage
tests/db/db.fixture.ts       worker-scoped pg connection and a rolled-back transaction helper
db/init/                     schema, indexes and seed, run in name order
sql/queries.sql              joins, aggregation, constraints and EXPLAIN examples for DBeaver or psql
.github/workflows/tests.yml  CI with a PostgreSQL service
```

## Choices

- Locators by role, placeholder and test id; no XPath and no fixed waits.
- A page object keeps the login selectors in one place.
- Database tests share one connection per worker, and the write test runs inside a transaction that is rolled back.
- CI uploads the HTML report as an artifact, so a failure can be inspected without running it locally.
