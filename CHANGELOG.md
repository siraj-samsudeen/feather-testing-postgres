# Changelog

Releases follow [semantic versioning](https://semver.org/).

## Unreleased

Additive — every 0.2 export keeps its meaning.

- **Engines and strategies**: `createFeatherDb({ engine, strategy, ... })` with
  `start / migrateOnce / beginTest / endTest / close`. Engines `pglite` and
  `postgres` (Bun.sql or postgres.js), chosen by `FEATHER_DB` (default
  `pglite`); strategies `tx` (default) and `clone`. `beginTest()` returns a
  Drizzle handle to inject into the app (`createApp({ db })`), raw `sql`, and
  the driver handle.
- Under `tx`, `raw` is serialised with `db` and `sql`: raw savepoints queue like
  app transactions, so a concurrent write never lands inside (and vanishes
  with) a raw savepoint.
  The client drizzle runs on is an adapter of our own (like `raw`), not the
  driver's client.
- **`db.$client` is hidden in tests (author's decision):** reading it on the
  test `db` or a transaction handle throws "db.$client is not available in
  tests: use db, sql or raw", and `in`, descriptors and spreading don't see
  it. Drizzle never reads `$client` itself, so queries, transactions,
  `execute`, `$count` and relational queries are unaffected. It reached
  transaction methods that bypassed the per-test scheduler.
- `raw.cursor` removed (author's decision): cursors bypassed the scheduler and
  could hang teardown; may return later as its own issue.
- **`raw` is a facade, decided by the author after repeated proxy escapes.**
  `TestDb.raw` is a frozen object of our own (`` raw`…` ``, `unsafe`,
  `savepoint`/`begin`), not the driver's handle.
  Successive review rounds found driver objects escaping every proxy guard
  (lazy queries, cursors, callback handles, `bind`, descriptor reads) and
  running SQL after the test ended; a facade exposes no driver object at all.
  Driver features beyond that list are not available through `raw`.
- **Test-database safety** (postgres engine): the URL comes from `url`,
  `FEATHER_DATABASE_URL`, `TEST_DATABASE_URL` or `DATABASE_URL`; whichever it
  is must name a test-named database in its path (query-parameter database
  selectors are refused) unless `allowAnyDatabase: true`, and the server's
  `current_database()` is checked after connecting. The driver is always
  handed the path's database explicitly (Bun.sql otherwise lets `PGDATABASE`
  override the path). **The URL must include the database name**: an empty
  path is refused (no fallback to `PGDATABASE` or the user). The library's
  own SQL runs with `search_path` pinned to `pg_catalog, pg_temp` (tests keep
  their own), so user-defined functions or operators can't stand in for
  built-ins. The library's own connections take only transport parameters
  from the URL and run no driver startup query (postgres.js `fetch_types`
  off), and the database check runs on one of them before any connection
  tests use opens: no SQL, the library's or a driver's, runs on a database
  not yet confirmed to be a test database. One URL means one server: host
  lists, `?host=`/`?hostaddr=`, a `PGHOST` list and `target_session_attrs`
  (URL or `PGTARGETSESSIONATTRS`) are refused; library connections keep a
  Unix socket (`?path=` for Bun.sql; postgres.js uses `PGHOST=/dir`).
- The bun entry and every runner-free module type-check without vitest (the
  createPgTest types moved to `client.ts`, `DbTestFixtures` to `fixtures.ts`;
  both still re-exported where they were). Use `customConditions: ["bun"]`
  or the runner-free subpaths when vitest isn't installed.
- Under Bun the root entry resolves (via a `bun` export condition) to a
  runner-free entry with no vitest import; `createPgTest`/`createDbTest` there
  throw a pointer to `feather-testing-postgres/bun`. Vitest consumers keep the
  default entry, unchanged.
- Fixture pairs follow feather-testing-core's rule: `[fn, {}]` is a fixture
  function with no options; for non-function values a two-element array is
  `[value, options]` only when the second element is a plain object with
  known option keys (`scope`, `deps`, `value`) — otherwise the array is the
  value (`[{ id: 1 }, { id: 2 }]`, `[1, {}]`).
- **Fixtures**: `postgresFixtures()` (definitions in feather-testing-core's
  Playwright-style shape, `[async (deps, use) => …, { scope, deps }]`),
  `useFixtures()`; bun:test helpers `sandboxEach()` /
  `useBunFixtures()` (`/bun`); Vitest `createDbTest()` (`/vitest`).
- `cleanupStale({ olderThan, url? })`: explicit cleanup of databases left by
  crashed `clone` runs (nothing is dropped automatically).
- **`/drizzle`**: `factory(table, defaults)` and `seq()`.
- **`/happy-dom`**: run the `/react` entry under bun:test.
- `createPgTest`: `seed` is a binding callback (default `saveRowSeed`, the
  0.2 behaviour); `mintToken` and `insertUser` are optional.
- `feather-testing-core` moves from `dependencies` to an optional peer
  (`>=0.4.0 <0.8`; `^0.7.0` once 0.7 is released), so an app no longer gets a
  second nested copy next to its own. Install it yourself if you use
  `/session` or `/react`.
- Peers: `vitest` becomes optional; `postgres`, `@electric-sql/pglite`,
  `drizzle-orm`, `@happy-dom/global-registrator` are new optional peers.

## 0.2.0

- **Breaking:** `seed(table, values)` now posts to `/api/save_row` with
  `{ table, row }` and returns a row keyed by `row_id`, replacing the retired
  `/api/save_doc` endpoint, `{ doctype, doc }` payload, and `name` key.

- **The Session DSL is no longer forked.** This package now depends on
  [`feather-testing-core`](https://github.com/siraj-samsudeen/feather-testing-core)
  (`^0.4.0`) for the chain, its step bookkeeping and its failure messages,
  and contributes only the DOM adapter — a subclass of core's `RTLDriver`
  whose lookups suit app markup. The two implementations had already begun to
  drift ([featherbase#225](https://github.com/siraj-samsudeen/featherbase/issues/225)).

  What a consumer gets for free: `assertValue`, `assertChecked` /
  `refuteChecked`, `assertSelected`, `assertOptions`, `upload`, `dropFile`,
  and the `step(name, fn)` escape hatch, all using this adapter's label
  lookup. `StepError` is now exported so a chain failure can be caught by
  type.

  Kept, because the markup this harness drives needs them: label resolution
  through wrapper siblings and trailing required markers; `choose` by label
  rather than accessible name; exact-then-containing name lookup for
  `clickButton` / `clickLink` / `click`; `clickButton`'s refusal to click a
  disabled button; containment `assertText` / `refuteText`; the 3000ms
  default lookup timeout; `fillIn` accepting a number.

  Reconciled to core, and therefore **behaviour changes**:
  - `submit()` no longer falls back to the first `<form>` in the page. It
    requires a prior field interaction and clicks the form's submit button
    (rather than calling `requestSubmit()`), so the browser's own click path
    runs.
  - `selectOption(label, option)` matches an `<option>` by its text only, not
    by its `value`.
  - Chain failures are headed `feather-testing-core: Step N of M failed` and
    quote step arguments with single quotes.
  - `within(selector, fn)`'s callback must return the scoped session or a
    promise; returning anything else is now a type error rather than a
    silently dropped chain.

- **Fixed:** `AppLike.request` accepts `Response | Promise<Response>`. Hono's
  `app.request` may answer synchronously, and consumers were wrapping it in
  `Promise.resolve()` to satisfy the old type.
- **Fixed:** `RenderAppOptions.user` is keyed by `row_id`, matching the wire
  vocabulary the rest of the package adopted, and the stored profile's
  fallback `email` now comes from it. It previously read a `name` field that
  no longer exists, writing `email: undefined` into the app's session.
- Docs and fixture names speak rows and tables: `seed(table, values)`,
  `insertUser` returns a `row_id`.
- The library has its own test suite for the first time: 40 tests over the DOM
  adapter, the React entry point, and the sandbox driven through
  `createPgTest` against a real Postgres. `npm test` and `npm run typecheck`.

- **Breaking:** `renderDesk` -> `renderApp`, `RenderDeskOptions` ->
  `RenderAppOptions`, `DeskRenderResult` -> `RenderAppResult`. The old names
  were borrowed from one consumer's UI shell and have no bearing on what the
  helper does
  ([#1](https://github.com/siraj-samsudeen/feather-testing-postgres/issues/1)).

## 0.1.0

Initial extraction from the
[frappe-clone](https://github.com/siraj-samsudeen/frappe-clone) monorepo
(`packages/feather-testing-postgres`), where the library is exercised by a
320-test server suite and a 10-test web component suite
([frappe-clone#3](https://github.com/siraj-samsudeen/frappe-clone/pull/3)).

- `withSandbox` — Ecto-style per-test transaction rollback over a swappable
  postgres.js delegate; app-level `sql.begin` becomes `SAVEPOINT` under the
  sandbox.
- `createPgTest` — Vitest fixtures: `db` (auto), `api`, `admin`, `client`,
  `seed`, `createUser`; in-process `app.request` clients throwing
  `TestApiError` on non-2xx. FormData bodies keep their multipart boundary.
- Session DSL — fluent, thenable chain (`fillIn`, `selectOption`,
  `clickButton` — refuses disabled buttons — `assertText`, `within`, ...)
  with chain-trace failure messages.
- React integration — `installFetchBridge`, `renderDesk` (real route tree on
  memory history + fresh QueryClient), `renderSession`.
