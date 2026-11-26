# QA automation with Playwright and SQL

[![tests](https://github.com/lcarvalhosdet/qa-playwright-sql/actions/workflows/tests.yml/badge.svg)](https://github.com/lcarvalhosdet/qa-playwright-sql/actions/workflows/tests.yml)

UI, API and database tests in one small Playwright project, written in TypeScript and run on every push with GitHub Actions.

## What it tests

| Layer | Target | Tests |
| --- | --- | --- |
| UI | [Sauce Demo](https://www.saucedemo.com) | login and add to cart, locked-out user error, sort by price |
| API | [JSONPlaceholder](https://jsonplaceholder.typicode.com) | GET a post, POST a post, 404 for a missing post |
| Database | PostgreSQL 16 in Docker | queries (joins, GROUP BY with FILTER and HAVING, data-quality checks), functions (scalar and table, errors, volatility), procedures (atomic orders, stock locking, batch job with `COMMIT`), constraints (CHECK, UNIQUE, ENUM, generated and identity columns, foreign keys with RESTRICT and CASCADE) and index usage read from `EXPLAIN` |

## Database

A small e-commerce schema: `customers`, `products`, `orders`, `order_items` and `payments`. The SQL files in `db/init` run in name order:

| File | What it has |
| --- | --- |
| `01_schema.sql` | tables, an `order_status` ENUM, `CHECK` rules (no negative stock, known payment methods), identity keys, a generated `subtotal` column, foreign keys with `ON DELETE RESTRICT` and `CASCADE` |
| `02_indexes.sql` | indexes on the foreign keys, an expression index for case-insensitive unique emails, a partial index for pending orders |
| `03_seed.sql` | the data the tests rely on |
| `04_functions.sql` | `order_total` (PL/pgSQL, raises a custom SQLSTATE), `apply_discount` (`IMMUTABLE STRICT`), `customer_summary` (SQL table function, inlined by the planner), `can_fulfill` (SQL-standard `BEGIN ATOMIC` body) |
| `05_procedures.sql` | `place_order` (JSON items, row locks in id order, `INOUT` result, `EXCEPTION` block that translates an error), `pay_order`, `cancel_order` (status rules with custom SQLSTATEs), `expire_pending_orders` (batch job that commits after each batch) |

The constraint tests check the SQLSTATE code and the constraint name rather than the error text, and every write runs in a transaction that is rolled back. The index tests add 20,000 rows inside a transaction, run `ANALYZE` and assert on the plan from `EXPLAIN (FORMAT JSON)`.

The function tests compare `order_total` with an independent `GROUP BY` query, run `apply_discount` as a table of cases including rounding and the 0 and 100 edges, and check the properties that matter beyond the result: a `STABLE` function is refused in an index, a SQL function is inlined into the caller's plan, and a `BEGIN ATOMIC` body blocks dropping a column it reads.

The procedure tests follow an order through place, pay and cancel, checking the stock and the copied prices at each step, and run every invalid input as a case with its SQLSTATE and message. The atomicity test runs without a wrapping transaction: one good item and one that fails, then it checks that neither the order nor the stock change was saved. The batch job commits for real, so it runs in a separate `db-commit` Playwright project that starts after the other database tests. It creates its own data, proves each batch was its own transaction by counting distinct `xmin` values, and deletes everything at the end.

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
tests/db/functions.spec.ts   functions: results, errors, volatility, inlining
tests/db/procedures.spec.ts  procedures: order flow, invalid input, atomicity
tests/db/expire.commit.spec.ts  batch job that commits, in the db-commit project
tests/db/db.fixture.ts       worker-scoped pg connection and a rolled-back transaction helper
db/init/                     schema, indexes, seed, functions and procedures, run in name order
sql/queries.sql              examples of everything above for DBeaver or psql
.github/workflows/tests.yml  CI with a PostgreSQL service
```

## Choices

- Locators by role, placeholder and test id; no XPath and no fixed waits.
- A page object keeps the login selectors in one place.
- Database tests share one connection per worker, and tests that write run inside a transaction that is rolled back. The few that must commit run in their own project, after the rest.
- CI uploads the HTML report as an artifact, so a failure can be inspected without running it locally.
