# QA automation with Playwright and SQL

[![tests](https://github.com/lcarvalhosdet/qa-playwright-sql/actions/workflows/tests.yml/badge.svg)](https://github.com/lcarvalhosdet/qa-playwright-sql/actions/workflows/tests.yml)

UI, API and database tests in one small Playwright project, written in TypeScript and run on every push with GitHub Actions.

## What it tests

| Layer | Target | Tests |
| --- | --- | --- |
| UI | [Sauce Demo](https://www.saucedemo.com) | login and add to cart, locked-out user error, sort by price |
| API | [JSONPlaceholder](https://jsonplaceholder.typicode.com) | GET a post, POST a post, 404 for a missing post |
| Database | PostgreSQL 16 in Docker | no orphan orders, LEFT JOIN for customers without orders, GROUP BY with HAVING, foreign key rejects bad data |

## Run it

Requirements: Node.js 20 or newer and Docker.

```bash
npm ci
npx playwright install chromium
docker compose up -d     # PostgreSQL with the seed in db/init
npm test                 # all tests
npm run test:web         # UI and API only, no database needed
npm run report           # open the HTML report
```

## Structure

```text
pages/login-page.ts          page object for the login screen
tests/ui/                    UI tests (Sauce Demo)
tests/api/                   API tests (JSONPlaceholder)
tests/db/                    SQL checks with a worker-scoped pg fixture
db/init/01_schema.sql        tables and seed data
sql/queries.sql              JOIN, GROUP BY and HAVING examples for DBeaver or psql
.github/workflows/tests.yml  CI with a PostgreSQL service
```

## Choices

- Locators by role, placeholder and test id; no XPath and no fixed waits.
- A page object keeps the login selectors in one place.
- Database tests share one connection per worker, and the write test runs inside a transaction that is rolled back.
- CI uploads the HTML report as an artifact, so a failure can be inspected without running it locally.
