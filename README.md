# feather-testing-postgres

> Sibling of [feather-testing-convex](https://github.com/siraj-samsudeen/feather-testing-convex) for
> React + Hono + Postgres stacks. Extracted from
> [featherbase](https://github.com/siraj-samsudeen/featherbase) (developed under
> the working name frappe-clone), where it is exercised by a 320-test server
> suite and a 10-test component suite.

### How do you test a React component that talks to a Postgres-backed server?

| Approach | Tests backend logic | Tests component rendering | Tests the integration | Fast | Isolated |
|----------|:---:|:---:|:---:|:---:|:---:|
| Server-only (HTTP tests + manual cleanup) | ✅ | ❌ | ❌ | ✅ | ❌ |
| Component with mocks (`vi.mock`/MSW) | ❌ | ✅ | ❌ | ✅ | ✅ |
| E2E (Playwright) | ✅ | ✅ | ✅ | ❌ | ❌ |
| **This library** | **✅** | **✅** | **✅** | **✅** | **✅** |

Inspired by **Phoenix**: Ecto's SQL Sandbox runs every test inside a real
database transaction that is rolled back at the end, so tests are fast,
perfectly isolated, and exercise the production code path — no mocks, no
fixtures files, no cleanup code. This library brings that model to a
React + Hono + Postgres stack (and pairs it with the MECE component-testing
philosophy of
[feather-testing-convex](https://github.com/siraj-samsudeen/feather-testing-convex)).

## How it works

1. **SQL sandbox** — the app exports its postgres.js handle through a
   delegating proxy (`_setSqlDelegate` seam). `withSandbox` opens a real
   transaction, swaps the delegate, runs the test, and ALWAYS rolls back.
   While sandboxed, the app's own `sql.begin(...)` calls become
   `SAVEPOINT`s — the app still gets atomic "transactions" (aborted saves
   roll back to the savepoint), but nothing ever commits.
2. **In-process server** — under `NODE_ENV=test` the Hono `app` binds no
   port; requests dispatch via `app.request(path, init)`. Auth is real
   (JWT), users are real rows — created inside the sandbox.
3. **Fetch bridge (component tests)** — `installFetchBridge(app)` patches
   jsdom's `fetch` so the app's own api client (`fetch('/api/...')`) lands
   on the in-process server. `renderApp(path)` mounts the REAL route tree
   on a memory history with a fresh QueryClient: component → fetch → Hono →
   sandboxed Postgres, end to end, in milliseconds.

## Engines and strategies (Bun.sql, postgres.js, PGlite)

Two setups are supported side by side:

- **postgres.js + Vitest with a delegate seam** — the 0.2 API below
  (`createPgTest`, `withSandbox`), unchanged. featherbase uses it.
- **Injection, any runner** — the app takes its database as an argument
  (`createApp({ db })`) and the test hands it a Drizzle handle bound to the
  test's transaction. No global delegate, no SQL proxy. Runs under `bun test`
  or Vitest, on PGlite or a real Postgres.

Postgres is the only dialect; PGlite *is* Postgres (compiled to WASM,
in-process). Two settings pick how tests run:

| Setting | Values | Default |
|---|---|---|
| **engine** — where the database lives | `pglite` (in-process, nothing installed) · `postgres` (a real server via Bun.sql under Bun, postgres.js under Node; `DATABASE_URL`) | `FEATHER_DB` env, else `pglite` — a fresh clone tests with nothing installed |
| **strategy** — how tests are isolated | `tx`: one transaction per test, always rolled back; the app's own `db.transaction()` becomes a SAVEPOINT · `clone`: a fresh database per test copied from a migrated template (`CREATE DATABASE … TEMPLATE` on Postgres, a `dumpDataDir` snapshot on PGlite), real COMMITs | `tx`; opt into `clone` per file for commit-dependent code |

Measured on an M-series Mac (Bun 1.4.2, Postgres 17, PGlite 0.5.11), per
test: `tx` ≈ 0.2 ms on every engine and driver; `clone` ≈ 68 ms on both.
Engine start + migrations: PGlite ≈ 0.6 s, Postgres ≈ 15–65 ms.

### Which database (postgres engine)

Tests never run against a non-test database by accident. The URL is the
`url` option, else `FEATHER_DATABASE_URL`, else `TEST_DATABASE_URL`, else
`DATABASE_URL` — and `DATABASE_URL` only when its database is named like a
test database (`test` as a word part: `app_test`, `test_db`, `my-test-db`),
or with `allowAnyDatabase: true`. Anything else is refused before connecting,
naming the database. `resolveTestDatabaseUrl(options?)` applies the same rule.

### The injection contract (Elysia)

```ts
// src/app.ts — production passes the real db; tests pass the test's handle
export function createApp({ db }: { db: FeatherDrizzleDb }) {
  return new Elysia()
    .get('/todos', async () => db.select().from(todos))
    .post('/todos', async ({ body }) => {
      await db.transaction(async (tx) => {          // a SAVEPOINT under `tx`
        await tx.insert(todos).values({ title: body.title })
      })
      return { ok: true }
    })
}
```

```ts
// test/todos.test.ts (bun test)
import { test, expect } from 'bun:test'
import { postgresFixtures, useBunFixtures } from 'feather-testing-postgres/bun'
import { factory, seq } from 'feather-testing-postgres/drizzle'

const t = useBunFixtures({
  ...postgresFixtures({ migrations: './drizzle' }),   // engine from FEATHER_DB
  app: async ({ db }, use) => use(createApp({ db })),
})
const userFactory = factory(users, { email: seq((n) => `u${n}@x.test`), name: 'Ada' })

test('lists todos', async () => {
  const u = await userFactory.insert(t.db)
  await t.db.insert(todos).values({ title: 'fixture', ownerId: u.id })
  const res = await t.app.handle(new Request('http://localhost/todos'))
  expect(await res.json()).toHaveLength(1)
})                                                    // rolled back here
```

`app.listen(0)` works too: a browser test's parallel requests queue on the
test's one transaction and see its fixture rows.

**Under `tx`, concurrent requests are serialised.** Everything in a test shares
one transaction, and the app's transactions are SAVEPOINTs in it, so work in
flight together would otherwise interleave. A transaction waits for its open
siblings and settles only after its own child transactions (children still
queued when it fails are cancelled with a clear error); a plain query through
`db` or `sql` waits for transactions open outside it, and runs at once inside
the transaction whose callback issued it. `raw` follows the same rules:
`raw.savepoint`/`raw.begin` queue like app transactions and raw queries like
`sql`.

Which transaction a query belongs to is tracked through the async context
(`AsyncLocalStorage`). Code that loses it — a worker, queue or event emitter
set up outside the transaction, running work for it — would wait for the
very transaction it belongs to. Such a wait is bounded: past `endTestGraceMs`
it fails with "…async context lost?" instead of hanging the test. Run that
work inside the transaction's callback (or pass it the `tx`).

**Nothing outlives the test.** Once `endTest()` begins, `db`, `sql` and `raw`
reject every query — issued late or still queued — with "this test has ended
— a query ran after endTest; await your app's work before the test finishes"
(drizzle wraps it as the `cause` of its query error). App transactions still
in flight get up to 2 s (`endTestGraceMs`) to settle inside the test
transaction before it rolls back, so nothing reaches the bare connection
(where postgres.js would autocommit). If they still haven't settled, the
Postgres engine destroys that connection and opens a fresh one rather than
hand it to the next test. (Elysia's `handle` needs a
URL whose host is at least as long as `localhost`; `http://app/x` misroutes.)

### The API

```ts
import { createFeatherDb } from 'feather-testing-postgres'   // or /engine (runner-free)

const fdb = createFeatherDb({
  engine?: 'pglite' | 'postgres',      // FEATHER_DB, else 'pglite'
  strategy?: 'tx' | 'clone',           // 'tx'
  url?: string,                        // see "Which database" below
  allowAnyDatabase?: boolean,          // accept a non-test-named DATABASE_URL
  driver?: 'bun' | 'postgres-js',      // Bun.sql under Bun, else postgres.js
  migrations?: string,                 // drizzle-kit folder, applied once
  setup?: (sql) => unknown,            // once, after migrations (clone: on the template)
  schema?: Record<string, unknown>,    // for db.query.*
  pglite?: { extensions?: … },         // PGlite constructor options
})
await fdb.start()                          // boot + migrate; idempotent
await fdb.migrateOnce(folder)              // once per FeatherDb (tx: the db; clone: the template)
const { db, sql, raw } = await fdb.beginTest()
await fdb.endTest()                        // rollback / drop the clone
await fdb.close()
```

`db` is Drizzle (drizzle-orm `0.45.x`, an optional peer); `sql` is a tagged
template returning rows, plus `sql.unsafe(text, params)`, on the same
transaction; `raw` is a small raw-SQL facade (below). The rows differ:
`sql` returns the driver's own row objects (Bun.sql / postgres.js / PGlite
results, e.g. with their date and JSON parsing), while `raw` returns plain
objects copied out of them.

### `raw`

`raw` is a frozen object of this library's own, the same on every engine:

| Member | What it does |
|---|---|
| `` raw`select … ${v}` `` | A query; interpolated values are bound parameters. Resolves to plain row objects. |
| `raw.unsafe(text, params?)` | A query from SQL built at runtime. |
| `raw.savepoint(fn)` / `raw.begin(fn)` | Runs `fn(child)`: kept if it resolves, rolled back if it throws. `child` is another `raw`. Under `tx` both are SAVEPOINTs (the test's transaction is already open); only on a `clone` database is the outermost `begin`/`savepoint` a real transaction. |

Every member checks that the test is still open, and results are plain data.
Batched reads (cursors) are not offered: test data is small — page with
`LIMIT`/`OFFSET` instead.

`db.$client` is hidden in tests: reading it throws ("use db, sql or raw").
Drizzle itself never needs it.
**Driver features beyond this list are not available in tests, by design.**
A driver handle is full of executables (lazy queries, cursors, child handles
passed to callbacks, bound copies) and every proxy we put around one leaked
a path that ran SQL after the test ended — on postgres.js straight onto the
bare connection, where it autocommits. So `raw` exposes no driver object at
all: nothing reachable from it (properties, descriptors, prototypes, symbols,
`call`/`apply`/`bind`) leads to one. Use `db` or `sql` for everything else.

**Fixtures.** `postgresFixtures(options | fdb)` returns definitions in the
Playwright Test shape that feather-testing-core's fixture engine takes — each
is `[async (deps, use) => { …; await use(value); …teardown }, { scope, deps }]`:

| Fixture | Scope | Deps | Value |
|---|---|---|---|
| `dbEngine` | file | — | the started `FeatherDb` (closed afterwards) |
| `testDb` | test | `dbEngine` | `{ db, sql, raw }` (ended afterwards) |
| `db` | test | `testDb` | the Drizzle handle |
| `sql` | test | `testDb` | raw SQL on the same transaction |

Runner helpers on top of them:

- **feather-testing-core ≥ 0.7** (optional peer): a test names what it needs,
  and only that is set up.

  ```ts
  import { afterAll, test as bunTest } from 'bun:test'
  import { coreFixtures, defineTest } from 'feather-testing-core/fixtures'
  export const test = defineTest({ test: bunTest, afterAll }, coreFixtures())
    .extend(postgresFixtures({ migrations: './drizzle' }))
  test('lists todos', async ({ db }) => { /* … */ })
  ```

- **bun:test** (`feather-testing-postgres/bun`): `sandboxEach(options)` returns
  live `{ db, sql, testDb, dbEngine }`; `useBunFixtures(defs)` runs your own
  definitions alongside. Both use beforeAll/beforeEach hooks and set up every
  fixture. **Tests must run sequentially**: bun runs files one after another
  in one process (module state is shared) and a file's tests in order — that
  is what one-transaction-per-test needs. Never use `test.concurrent`;
  `beginTest()` refuses to open a second test while one is open.
- **Vitest** (`feather-testing-postgres/vitest`): `createDbTest(options)` is a
  `test.extend` with the same four fixtures (`dbEngine` file-scoped; Vitest
  ≥ 3.2). Only the fixtures a test destructures are set up.
- **Factories** (`feather-testing-postgres/drizzle`): `factory(table, defaults)`
  → `insert(db, overrides?)`, `insertMany(db, n, overrides?)`, `build(overrides?)`,
  typed from `$inferInsert`/`$inferSelect`; `seq((n) => …)` for unique values.
  Overrides become required when a required column has no default.

### PGlite gaps

PGlite runs the real Postgres engine, but it is not a server:

- **Extensions must be imported as PGlite modules** and passed in
  (`pglite: { extensions: { vector } }`); `CREATE EXTENSION` alone fails for
  anything not bundled.
- **One connection.** Queries serialise; overlapping transactions queue.
- **`now()` is frozen within a test** under `tx` (true on Postgres too: it is
  the transaction start time). Use `clone` or `clock_timestamp()` when time
  must move.
- **Transaction options are ignored under `tx`**: `db.transaction(fn, {
  isolationLevel, accessMode, deferrable })` runs, but as a SAVEPOINT in the
  test's transaction, whose mode it can't change. Code that depends on
  isolation (serialization failures, read-only enforcement) belongs in a
  `clone` file, where transactions are real.
- **No cross-process `LISTEN/NOTIFY`**, no replication, no other clients.

So **CI runs a real-Postgres lane pinned to production's major version**
(`FEATHER_DB=postgres`, e.g. a `postgres:17` service) alongside the PGlite
lane; this repo's own CI does exactly that.

### Component tests under bun

The `/react` entry runs under `bun test` with happy-dom: preload
`feather-testing-postgres/happy-dom` (bunfig `[test] preload`, or
`bun test --preload`). It registers happy-dom's DOM globals but keeps Bun's
own `fetch`/`Request`/`Response`. Vitest keeps `environment: 'jsdom'`.

## Quick start (server test, postgres.js + Vitest)

```ts
// test/pg-test.ts — bind the library to your app once
import { app } from '../src/index'
import { sql, _setSqlDelegate } from '../src/db'
import { invalidateMeta } from '../src/meta'
import { issueSession } from '../src/auth'
import { saveRow } from '../src/document'
import { createPgTest } from 'feather-testing-postgres'

export const test = createPgTest({
  app,
  sql,
  setDelegate: _setSqlDelegate,
  onTeardown: () => invalidateMeta(),
  mintToken: async (user) => (await issueSession(user)).token,
  insertUser: async ({ email, roles }) => {
    const row = await saveRow('User', { row_id: email, email, enabled: true,
      roles: roles.map((role) => ({ role })) }, 'Administrator')
    return String(row.row_id)
  },
})
```

```ts
// test/ticket.test.ts
import { test } from './pg-test'
import { expect } from 'vitest'

test('reporters see only their own tickets', async ({ seed, createUser }) => {
  const alice = await createUser({ roles: ['Ticket Reporter'] })
  await seed('Ticket', { title: 'Someone else’s ticket' })          // as admin
  const mine = await alice.post('/api/save_row', {
    table: 'Ticket', row: { title: 'Mine' } })

  const list = await alice.get<{ data: { row_id: string }[] }>('/api/resource/Ticket')
  expect(list.data.map((r) => r.row_id)).toEqual([mine.row_id])
})
// No cleanup. The transaction rolls back. The database is untouched.
```

## Quick start (component test)

```tsx
import { screen } from '@testing-library/react'
import { test, expect, renderSession } from './pg-test'   // web binding

test('create a ticket through the real UI', async ({ admin }) => {
  const { session } = await renderSession('/admin/Ticket/new', admin)
  await session
    .fillIn('Title', 'Filed from a component test')
    .selectOption('Priority', 'High')
    .clickButton('Save')
    .assertText('TICK-0006')          // real naming series, sandboxed
})
```

## Fixtures

`createPgTest(bindings, options?)` returns a Vitest `test` whose fixtures
all run inside the per-test transaction:

| Fixture | Description |
|---------|-------------|
| `db` | The sandbox transaction handle (raw SQL inside the test tx). Auto — every test is sandboxed even without touching it. |
| `api` | Anonymous in-process client (`get/post/put/delete/fetch`). |
| `admin` | Administrator-authenticated client. |
| `client` | A freshly created regular user (default roles from `options.defaultRoles`). |
| `seed(table, values)` | Insert a row. Default: through the REAL save lifecycle (`POST /api/save_row` as admin). Pass `seed: (table, values, { db, api, admin }) => …` in the bindings to seed your own way. Returns the saved row, including its `row_id`. |
| `createUser(opts)` | Create another user (email/fullName/roles); returns an authenticated client. |

`mintToken` and `insertUser` are optional bindings: leave them out when the
app has no users, and only `admin` / `client` / `createUser` will ask for them.

Clients throw `TestApiError { status, type, fields }` on non-2xx — assert
with `rejects.toMatchObject({ status: 403 })`.

## Session DSL

`renderSession(path, client)` returns `{ session }` — a fluent, chainable
driver. Methods queue; `await` executes the chain.

The DSL itself is
[feather-testing-core](https://github.com/siraj-samsudeen/feather-testing-core):
this package contributes the DOM adapter, so the same vocabulary drives a
component test here and a Playwright E2E test there. Every core verb is
available — `fillIn`, `selectOption`, `check`/`uncheck`/`choose`, `click`,
`clickButton`, `clickLink`, `submit`, `upload`, `dropFile`, `assertText`,
`refuteText`, `assertValue`, `assertChecked`/`refuteChecked`,
`assertSelected`, `assertOptions`, `within(selector, fn)`, `step(name, fn)`,
`debug()`. `visit`, `assertPath`, `refutePath`, `assertHas` and `refuteHas`
throw: there is no URL bar in jsdom.

Four verbs are deliberately adapted to app markup rather than textbook markup:

| Verb | Adapted behaviour |
|------|-------------------|
| `fillIn` and every other label-addressed verb | Resolves `<label>Subject *</label>` sitting as a **sibling** of its control inside a wrapper `<div>` — no `htmlFor` needed — and ignores the trailing required marker. Falls back to a placeholder. Also accepts a number |
| `choose` | By label, for the same reason: a radio with a sibling label has no accessible name |
| `clickButton` / `clickLink` / `click` | Exact name first, then a name that *contains* it — an ordered fallback, so the lookup is never ambiguous. `clickButton` refuses a disabled button rather than clicking into the void |
| `assertText` / `refuteText` | Containment checks over the rendered text, so `assertText('TICK-')` can assert a generated id's prefix |

Failures print the whole chain:

```
feather-testing-core: Step 3 of 4 failed

Failed at: clickButton('Save')
Cause: Button "Save" is disabled — a user could not click it

Chain:
    [ok] fillIn('Title', 'x')
    [ok] selectOption('Priority', 'High')
>>> [FAILED] clickButton('Save')
    [skipped] assertText('TICK-')
```

## Limitations & notes

- **One connection per test**: all sandboxed queries serialize on the test
  transaction's connection. Parallel test FILES are separate processes with
  separate transactions — safe, but they contend on shared row locks
  (e.g. naming-series counters), so keep `fileParallelism: false` unless
  your tests avoid shared counters.
- **`SET TRANSACTION` inside a sandbox** (e.g. a read-only report txn)
  cannot change the already-started outer transaction's mode; such code
  runs, but without the read-only guard, under the sandbox.
- **Process caches**: anything cached per-process (DocType meta, rate-limit
  buckets) must be cleared in `onTeardown` or rolled-back state leaks
  between tests.
- **Commit-after side effects** (job queue rows, emails) written through
  the same `sql` seam are sandboxed too — they roll back with the test.
- **`now()` freezes at BEGIN** inside the sandbox transaction, while
  wall-clock timestamps (`new Date()`) keep moving. Code that compares a
  wall-clock-stamped column against `now()` (e.g. a job queue's
  `run_at <= now()`) won't see rows written mid-test — nudge them onto the
  transaction clock first:
  `update jobs set run_at = now() where run_at <= clock_timestamp()`.

## Installation

```bash
npm install -D feather-testing-postgres
```

`feather-testing-core` is a peer dependency (optional: only the `/session` and
`/react` entries need it — it is where the Session DSL lives), so your app and
this package share one copy. Install it alongside: `npm install -D
feather-testing-core`. The range is `>=0.4.0 <0.8` for now; it becomes
`^0.7.0` when core 0.7 (with the fixture engine) is released.

Peer dependencies, all optional — install what your setup uses: `vitest`
(Vitest helpers), `postgres` (postgres.js under Node), `@electric-sql/pglite`
(the PGlite engine), `drizzle-orm` 0.45.x (`db` handles, migrations,
factories), `@happy-dom/global-registrator` (component tests under bun), plus `react`, `react-dom`,
`@tanstack/react-query`, `@tanstack/react-router`, and
`@testing-library/{dom,react,user-event}` for the `/react` and `/session`
entry points. The package ships TypeScript source — Bun and Vitest transform
it natively, so no build step is involved.

## Adding the sandbox seam to your app

The library needs one thing from your app: a swappable delegate around your
postgres.js handle. Replace `export const sql = postgres(...)` with:

```ts
import postgres from 'postgres'

const root = postgres(process.env.DATABASE_URL!)

let delegate = root
export function _setSqlDelegate(tx: unknown | null) {
  delegate = (tx as typeof root) ?? root
}

export const sql = new Proxy((() => {}) as unknown as typeof root, {
  apply: (_t, _this, args) => (delegate as unknown as (...a: unknown[]) => unknown)(...args),
  get(_t, prop) {
    if (delegate !== root) {
      // Sandbox mode: app transactions become savepoints on the test tx —
      // a real BEGIN/COMMIT would commit the outer test transaction.
      if (prop === 'begin')
        return (first: unknown, second?: unknown) => {
          const fn = (typeof first === 'function' ? first : second) as (s: unknown) => unknown
          return (delegate as unknown as { savepoint: (f: typeof fn) => unknown }).savepoint(fn)
        }
      if (prop === 'end') return async () => {} // a sandboxed suite must not close the pool
    }
    const v = (delegate as never)[prop] as unknown
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(delegate) : v
  },
})
```

The proxy is transparent in production (delegate === root always). Pass
`sql` + `_setSqlDelegate` into `createPgTest` and everything else follows.

## Developing this library

```bash
npm install
npm run typecheck
npm test
```

The suite has three parts: the DOM adapter and the Session it binds
(`tests/session.test.tsx`), the React entry point's fetch bridge and
`renderApp`/`renderSession` (`tests/react.test.tsx`), and the sandbox itself
driven through `createPgTest` against a **real** Postgres
(`tests/sandbox.test.ts`). `tests/types/consumer-surface.ts` compiles — but
does not run — the shapes a consumer binds this harness with, so a type that
drifts fails here rather than in the consumer's repo.

Four lanes — each runner on each engine:

```bash
npm run test:vitest:pglite      # = npm test with FEATHER_DB unset
npm run test:bun:pglite
createdb feather_harness_test
export DATABASE_URL=postgres://localhost:5432/feather_harness_test
npm run test:vitest:postgres    # also runs the postgres.js delegate suite
npm run test:bun:postgres
```

`tests/contract/` holds suites written once and run by both runners
(`tests/bun/`, `tests/vitest/`). Never point `DATABASE_URL` at a database you
care about — the suites create and drop tables in it, and `clone` creates and
drops `feather_tpl_<host>_<pid>_<created>_*` / `feather_t_<host>_<pid>_<created>_*`
databases next to it (`<host>` is a hash of the hostname), and drops only
what it created. A crashed run leaves its databases behind, and nothing drops
them automatically: a hostname is not a pid namespace (containers share
hostnames), so no run can prove another's template abandoned. Clean up
explicitly with `cleanupStale({ olderThan: ms, url? })` — e.g. as a CI setup
step, or by hand — and only while no other test run shares the server: it
drops any host's feather databases older than that age (never this host's
live pids, never a database with open connections).
