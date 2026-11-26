# QA automation with Playwright and SQL

[![tests](https://github.com/lcarvalhosdet/qa-playwright-sql/actions/workflows/tests.yml/badge.svg)](https://github.com/lcarvalhosdet/qa-playwright-sql/actions/workflows/tests.yml)

UI, API and database tests in one Playwright project, written in TypeScript and run on every push with GitHub Actions. The database part is the largest: a small PostgreSQL shop whose business rules live in the database (constraints, functions, procedures, triggers, views), with tests for each rule, including what happens when several sessions run at once.

## What it tests

| Layer | Target | Tests |
| --- | --- | --- |
| UI | [Sauce Demo](https://www.saucedemo.com) | login and add to cart, locked-out user error, sort by price |
| API | [JSONPlaceholder](https://jsonplaceholder.typicode.com) | GET a post, POST a post, 404 for a missing post |
| Database | PostgreSQL 16 in Docker | constraints and indexes, functions, stored procedures, triggers, reporting views, upsert, concurrency (lost updates, isolation levels, deadlocks, optimistic and advisory locks) |

## Database

Tables: `customers`, `products`, `categories`, `orders`, `order_items` and `payments`, plus `audit_log`, `stock_alerts` and `order_status_transitions` used by the triggers. The files in `db/init` run in name order, the way migrations would:

| File | What it has |
| --- | --- |
| `01_schema.sql` | an `order_status` ENUM, `CHECK` rules (no negative stock, known payment methods), identity keys, a generated `subtotal` column, foreign keys with `ON DELETE RESTRICT` and `CASCADE` |
| `02_indexes.sql` | indexes on the foreign keys, an expression index for case-insensitive unique emails, a partial index for pending orders |
| `03_seed.sql` | the data the tests rely on |
| `04_functions.sql` | `order_total` (PL/pgSQL with a custom SQLSTATE), `apply_discount` (`IMMUTABLE STRICT`), `customer_summary` (SQL table function, inlined by the planner), `can_fulfill` (`BEGIN ATOMIC` body) |
| `05_procedures.sql` | `place_order` (JSON items, row locks in id order, `INOUT` result, an `EXCEPTION` block that translates an error), `pay_order`, `cancel_order`, `expire_pending_orders` (batch job that commits after each batch, with `FOR UPDATE SKIP LOCKED`) |
| `06_triggers.sql` | `updated_at` (`BEFORE UPDATE` with `WHEN`), status changes checked against a rules table, a JSONB audit log kept append-only, stock alerts from a `FOR EACH STATEMENT` trigger with transition tables, a deferred constraint trigger that rejects an order without items at `COMMIT` |
| `07_advanced_queries.sql` | recursive CTEs over a category tree (with the `CYCLE` clause and a closure table), window functions (`ROW_NUMBER`, `RANK`, `DENSE_RANK`, running total, `LAG`), `ROLLUP` with `GROUPING()`, a materialized view with a 7-day `RANGE` window, an `INSERT ... ON CONFLICT DO UPDATE` import |
| `08_concurrency.sql` | a `version` column and `update_product_price` for optimistic locking, `refresh_daily_sales` guarded by an advisory lock |

Every file starts with a comment that explains its concepts, and [`sql/queries.sql`](sql/queries.sql) has runnable examples of all of them for DBeaver or psql, including two-session scripts for the concurrency scenarios.

### How the database is tested

- **Errors by code, not by text.** Each failure case asserts the SQLSTATE (`23514`, `P0002`, `40001`, the custom `SH001` to `SH005`...) and the constraint name, so a test breaks only when the rule changes.
- **Isolation.** Tests share one connection per worker, and every test that writes runs inside a transaction that is rolled back. Tests that must commit, or hold locks across connections, run in the `db-serial` Playwright project, after the rest and one at a time, on data they create and delete.
- **Oracle checks.** Functions and views are compared with an independent query that computes the same number, such as `order_total` against a `GROUP BY`.
- **Atomicity.** A procedure call that fails halfway runs without a wrapping transaction, and the test checks that nothing was saved.
- **Plans, not only results.** Index tests add 20,000 rows, run `ANALYZE` and read `EXPLAIN (FORMAT JSON)`. A function test checks that a SQL function is inlined into the caller's plan.
- **Edges that are easy to miss.** A revenue tie that shows `RANK` and `DENSE_RANK` apart, an order at 23:30 in Recife that is already the next day in UTC, a loop in the category tree, a `NULL` city next to a subtotal row, a CTE that cannot see the row its own `INSERT` just wrote.
- **Concurrency without sleeps.** Two sessions interleave their transactions, and when one must wait the test polls `pg_blocking_pids()` until PostgreSQL reports the wait. The scenarios: a lost update and four ways to prevent it, non-repeatable reads, write skew under `REPEATABLE READ` and `SERIALIZABLE`, a deadlock, two customers racing for the last unit, `NOWAIT` and `lock_timeout`, a stale version rejected by optimistic locking, and an advisory lock that lets one refresh run at a time.

Two bugs were found this way and fixed: the batch job picked the same orders when two runs overlapped (fixed with `SKIP LOCKED`, and a test that fails without it), and an inlining test that depended on table statistics.

## Run it

Requirements: Node.js 20 or newer and Docker.

```bash
npm ci
npx playwright install chromium
docker compose up -d     # PostgreSQL with everything in db/init
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
pages/login-page.ts                 page object for the login screen
tests/ui/                           UI tests (Sauce Demo)
tests/api/                          API tests (JSONPlaceholder)
tests/db/db.fixture.ts              worker-scoped pg connection and a rolled-back transaction helper
tests/db/orders.spec.ts             queries and data-quality checks
tests/db/schema.spec.ts             constraints and index usage
tests/db/functions.spec.ts          functions: results, errors, volatility, inlining
tests/db/procedures.spec.ts         procedures: order flow, invalid input, atomicity
tests/db/triggers.spec.ts           triggers: updated_at, status rules, audit log, alerts, deferred rule
tests/db/reporting.spec.ts          views: recursive CTEs, window functions, ROLLUP, materialized view, upsert
tests/db/expire.serial.spec.ts      batch job that commits (db-serial project)
tests/db/concurrency.serial.spec.ts two sessions at once: locks, isolation, deadlocks (db-serial project)
db/init/                            schema, indexes, seed, functions, procedures, triggers, views, concurrency
sql/queries.sql                     examples of everything above for DBeaver or psql
.github/workflows/tests.yml         CI with a PostgreSQL service
```

## Choices

- Locators by role, placeholder and test id; no XPath and no fixed waits.
- A page object keeps the login selectors in one place.
- Database tests share one connection per worker and roll back what they write. The few that must commit or hold locks across connections run in their own project, after the rest.
- CI uploads the HTML report as an artifact, so a failure can be inspected without running it locally.
