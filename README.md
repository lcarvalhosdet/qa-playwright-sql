# QA automation with Playwright and SQL

[![tests](https://github.com/lcarvalhosdet/qa-playwright-sql/actions/workflows/tests.yml/badge.svg)](https://github.com/lcarvalhosdet/qa-playwright-sql/actions/workflows/tests.yml)

UI, API and database tests in one Playwright project, written in TypeScript and run on every push with GitHub Actions. At its center is a small PostgreSQL shop whose business rules live in the database (constraints, functions, procedures, triggers, views), a REST API over it, and tests that follow a request from HTTP down to the rows it changed, including what happens when several sessions run at once.

## What it tests

| Layer | Target | Tests |
| --- | --- | --- |
| Shop API, end to end | the project's own API (`api/`) over the shop database | create, pay and cancel orders, then check stock, payments and the audit log in the database; error codes mapped to HTTP statuses; request validation; optimistic locking; two orders racing for the last unit |
| Database | PostgreSQL 16 | constraints and indexes, functions, stored procedures, triggers, reporting views, upsert, concurrency (lost updates, isolation levels, deadlocks, optimistic and advisory locks), roles and row-level security |
| Performance | the same schema with 200,000 orders | the plan of each hot query and a budget of pages it may read, partition pruning, BRIN, redundant and missing indexes |
| UI | [Sauce Demo](https://www.saucedemo.com), a public demo store | login and add to cart, locked-out user error, sort by price |
| API | [JSONPlaceholder](https://jsonplaceholder.typicode.com), a public fake API | GET a post, POST a post, 404 for a missing post |

The UI and public API tests are examples against well-known practice sites; they do not touch the shop database.

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
| `09_order_limits.sql` | a limit of pending orders per customer, checked by a trigger that counts rows; exact only under `SERIALIZABLE`, which is why the API retries |
| `10_security.sql` | three least-privilege roles (the API, reporting, customers), routines closed to `PUBLIC`, `SECURITY DEFINER` procedures with a pinned `search_path` as the only write path, an audit log nobody can forge, row-level security so a customer sees only their own orders, and a `security_invoker` view so RLS is not bypassed through it |
| `11_performance.sql` | a composite covering index for a customer's latest orders (replacing a now-redundant one), indexes for the foreign keys added later, `audit_log` converted to monthly partitions with a BRIN index on its timestamp, and `pg_stat_statements` |

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

## Security

Until `10_security.sql`, everything ran as `qa`, a superuser that may do anything and is not subject to row-level security. That file adds three roles, each with only what it needs:

| Role | Can | Cannot |
| --- | --- | --- |
| `shop_api` (the API logs in as this) | read the tables and views its routes return; call `place_order`, `pay_order`, `cancel_order`, `update_product_price` | `INSERT`, `UPDATE` or `DELETE` any table directly; read or write `audit_log`; run the batch job |
| `shop_reporting` | read the report views | read `customers`, `orders`, `payments` or any other table |
| `shop_customer` | read the catalog, and their own customer row, orders, items and payments | see another customer's rows (RLS); write anything; read the cross-customer views |

How it fits together:

- **Writes only through procedures.** The write procedures are `SECURITY DEFINER`: they run with the owner's privileges, so `shop_api` can place an order without holding `INSERT` on `orders`. Every rule in them and in the triggers applies to every change, and a bug or an injection in the API cannot go around them. Each one pins `search_path`, so a caller cannot slip in a fake table or function with the same name.
- **Routines closed by default.** PostgreSQL lets `PUBLIC` execute every new function; `REVOKE` handles the existing ones and `ALTER DEFAULT PRIVILEGES` the ones created later. A catalog test checks that no routine is executable by `PUBLIC`, and caught that the `IN SCHEMA` form of that statement silently does nothing.
- **An audit log nobody can forge.** The audit trigger runs as the owner, so no role needs `INSERT` on `audit_log`, and none has it. It records the role that made the change (`shop_api` for the API), not the procedure's owner.
- **Row-level security.** The portal sets `app.customer_id` per transaction, and policies on `customers`, `orders`, `order_items` and `payments` return only that customer's rows; with the setting missing or empty, nothing. A plain view reads as its owner and would leak every row past RLS, which a test demonstrates; `order_totals` is `security_invoker`, so RLS applies through it.

The tests switch roles with `SET LOCAL ROLE` inside rolled-back transactions, and the end-to-end tests check that the API really connects as `shop_api`: not a superuser, not exempt from RLS, refused a direct `UPDATE`, and named in the audit log for the changes it makes.

## Performance

The seed is too small for plans to mean anything: with a handful of rows, reading a whole table is the right choice. For the `perf` project, `global-setup.ts` copies the database with `CREATE DATABASE shop_perf TEMPLATE shop` and fills it with `db/perf/volume.sql`: 20,000 customers, one wholesale customer with 5,000 orders, 205,000 orders over the last 12 months, 512,000 order items, 154,000 payments and 205,000 audit rows across 13 monthly partitions. It loads in about 4 seconds, with triggers and foreign key checks off (the data is consistent by construction) and `ANALYZE` after each bulk insert.

The tests in `tests/perf` run `EXPLAIN (ANALYZE, BUFFERS)` on the queries the shop runs most and check:

- **the plan**: which index, and no `Sort` or `Seq Scan` where there should be none. A customer's latest orders come from an Index Only Scan with no heap fetches.
- **a budget of buffers**: the 8 kB pages a query reads, about twice today's count. Pages measure work independently of the machine, so the budget fails when a query starts doing far more work, never because CI was slow. One test drops the index inside a transaction to show the budget catching it.
- **partitions**: a query for one month reads one partition; a lookup without the partition key has to visit them all.
- **BRIN**: under a tenth of the size of a B-tree on the same column, and used for date ranges.
- **pg_stat_statements**: the same query with different values is one entry, with `$1` in place of the value.

Two catalog checks run on the normal database too: every foreign key has an index that starts with its columns, and no index is redundant (the leading columns of another one). Both caught something: `categories` and `stock_alerts` had foreign keys added after phase 1 without an index.

One lesson came from the load itself: the `INSERT` of the order items took 19 seconds, because right after the bulk inserts the planner still had the statistics of the 4-row seed and chose a nested loop that rebuilt the product list for each of 205,000 orders. An `ANALYZE` before it brought it to under 2 seconds.

## Shop API

A small [Fastify](https://fastify.dev) app in `api/src`, connected as `shop_api`, with no business rules of its own: each route calls a procedure, function or view from `db/init`, and one table in `api/src/errors.ts` turns the database's SQLSTATE codes into HTTP statuses.

| Method and path | Calls | Errors |
| --- | --- | --- |
| `GET /health` | `SELECT 1` | |
| `GET /products`, `GET /products/:id` | `products` | 404 |
| `PATCH /products/:id/price` `{price, version}` | `update_product_price` | 409 `SH005` stale version, 400 invalid body |
| `POST /orders` `{customerId, items: [{productId, quantity}]}` | `CALL place_order` | 409 `SH001` stock, 409 `SH006` too many pending orders, 404 unknown customer or product, 422 duplicate product, 400 invalid body |
| `GET /orders/:id` | `order_totals`, `order_items`, `payments` | 404 |
| `POST /orders/:id/payment` `{method}` | `CALL pay_order` | 409 `SH002` not pending, 400 unknown method |
| `POST /orders/:id/cancel` | `CALL cancel_order` | 409 `SH002` already cancelled |
| `GET /reports/product-sales`, `GET /reports/category-sales` | the reporting views | |

Errors share one shape: `{"error": "...", "code": "SH001", "detail": "...", "hint": "..."}`. Money is a string (`"150.00"`), as PostgreSQL returns `NUMERIC`. Request bodies are checked by JSON schemas, and unknown fields are rejected: Fastify drops them silently by default, which a test caught.

### Retries

Writes run in a transaction that `api/src/retry.ts` repeats from `BEGIN` when it loses a race: `40001` (serialization failure) or `40P01` (deadlock), up to 8 attempts with exponential backoff and full jitter. Any other error is final. `POST /orders` runs as `SERIALIZABLE`, because the pending-order limit counts rows and only `SERIALIZABLE` stops two concurrent orders from both passing that count; payment and cancellation lock the rows they change, so `READ COMMITTED` is enough there. Every response from these routes has an `x-transaction-attempts` header, and a race that is still lost after the last attempt becomes `503` with `retry-after`.

The tests cover it at three levels: unit tests of the helper (which codes are retried, when it gives up, the backoff curve), database tests that show the limit broken under `READ COMMITTED` and kept under `SERIALIZABLE`, and an end-to-end test that sends 12 orders at once against a limit of 3: exactly 3 are created, 9 get `409 SH006`, none get `503`, and the attempts header proves the requests collided and were retried. The test makes the collision certain rather than likely: it holds a lock on `audit_log` as a barrier, so the requests count and insert, then wait, and are released together once more of them than the limit are waiting. With retries turned off, that test fails.

The tests start the API themselves. To try it by hand:

```bash
docker compose up -d     # the database on port 5432
npm run api              # http://127.0.0.1:3000, connects as shop_api (API_DB_URL to change)
curl -X POST localhost:3000/orders -H 'content-type: application/json' \
  -d '{"customerId": 1, "items": [{"productId": 1, "quantity": 2}]}'
```

## Run it

Requirements: Node.js 22.22 or newer and Docker running. Nothing else: the tests start their own PostgreSQL.

```bash
npm ci
npx playwright install chromium
npm test                 # all tests
npm run test:web         # UI and API only, no database
npm run test:db          # database only
npm run test:api         # shop API end to end (runs the database tests first)
npm run test:unit        # unit tests, no database
npm run test:perf        # plans and budgets on 200,000 orders (loads them first)
npm run report           # open the HTML report
```

`global-setup.ts` starts a fresh PostgreSQL 16 with [Testcontainers](https://testcontainers.com) for every run, loads everything in `db/init`, creates and fills `shop_perf` when the `perf` project runs, starts the shop API on top of it, and removes everything at the end. Both listen on random free ports, so they never clash with anything on 5432 or 3000. To run against a database you already have instead, set `DB_URL` (and `SHOP_API_URL` for an API already running):

```bash
DB_URL=postgresql://qa:qa@localhost:5432/shop npm test
```

`docker-compose.yml` is still there for exploring the database by hand in DBeaver or psql (`docker compose up -d`, port 5432). Its scripts run only when the volume is created, so after changing `db/init` recreate it with `docker compose down -v && docker compose up -d`.

### Checks

```bash
pip install -r requirements-dev.txt   # sqlfluff, once
npm run check                         # typecheck + lint + lint:sql
```

| Script | What it runs |
| --- | --- |
| `npm run typecheck` | `tsc` in strict mode. Playwright runs TypeScript without checking types, so this is the only place a type error shows up. |
| `npm run lint` | ESLint with the TypeScript and Playwright recommended rules (no conditionals in tests, no tests without assertions, no missing `await`). |
| `npm run lint:sql` | sqlfluff on `db/init` and `sql`, PostgreSQL dialect. `.sqlfluff` lists the rules left out and why. |

CI runs the checks and the tests as two parallel jobs.

## Structure

```text
pages/login-page.ts                 page object for the login screen
tests/ui/                           UI tests (Sauce Demo)
tests/api/                          API tests (JSONPlaceholder)
api/src/                            the shop API: app, error mapping, retries, routes
tests/unit/                         unit tests of pure functions (the retry helper)
tests/perf/                         plans and buffer budgets on the volume database
db/perf/volume.sql                  205,000 orders for the perf tests, loaded into shop_perf
tests/shop-api/                     end-to-end tests: HTTP request, then database checks
tests/db/db.fixture.ts              worker-scoped pg connection and a rolled-back transaction helper
tests/db/scratch.ts                 test data that commits for real, removed after each test
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
global-setup.ts                     starts PostgreSQL (Testcontainers) and the shop API for the run
.github/workflows/tests.yml         CI: checks job and tests job
.sqlfluff, eslint.config.mjs        lint rules for SQL and TypeScript
tsconfig.json                       strict type check
```

## Choices

- Locators by role, placeholder and test id; no XPath and no fixed waits.
- A page object keeps the login selectors in one place.
- Database tests share one connection per worker and roll back what they write. The ones that must commit, hold locks across connections or go through the API run in their own projects, after the rest, on data they create and delete.
- The API maps errors in one table and holds no rules of its own, so a rule is written once, in the database, and tested both directly and through HTTP.
- Every run gets a fresh database from Testcontainers, the same locally and in CI, so no test depends on what an earlier run left behind.
- CI uploads the HTML report as an artifact, so a failure can be inspected without running it locally.
