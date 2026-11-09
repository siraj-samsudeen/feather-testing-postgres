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

## Quick start (server test)

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
| `seed(table, values)` | Insert a row through the REAL save lifecycle as admin. Returns the saved row, including its `row_id`. |
| `createUser(opts)` | Create another user (email/fullName/roles); returns an authenticated client. |

Clients throw `TestApiError { status, type, fields }` on non-2xx — assert
with `rejects.toMatchObject({ status: 403 })`.

## Session DSL

`renderSession(path, client)` returns `{ session }` — a fluent, chainable
driver. Methods queue; `await` executes the chain.

The DSL itself is
[feather-testing-core](https://github.com/siraj-samsudeen/feather-testing-core):
this package contributes the DOM adapter, so the same vocabulary drives a
component test here and a Playwright E2E test there. Every core verb is
available — `fillIn` (with `{ sensitive: true }`), `selectOption`,
`check`/`uncheck`/`choose`, `click`, `clickButton`, `clickLink`, `submit`,
`upload`, `dropFile`, `assertText`, `refuteText`, `assertExactText`,
`assertAttribute`/`refuteAttribute`, `assertValue`,
`assertChecked`/`refuteChecked`, `assertSelected`, `assertOptions`,
`within(selector, fn, opts?)`, `step(name, fn)`, `debug()`.

Every waiting verb takes `{ timeout }` in ms, which outlasts the session's
(`createSession({ timeout })`, default 3000): `clickButton('Approve', { timeout: 10_000 })`.
`0` means no limit.

`within(selector, fn)` waits for `selector` to match, then needs **exactly
one** match: none or several fail the step, naming the count, so narrow the
selector. The scope is the selector, looked up again at every step inside, so
a scope React remounts as a new element keeps working. On a shadow host
(a custom element with an open shadow root), the scope is both its shadow
tree and the light-DOM children it slots in:

```ts
await session.within('featherbase-bar', (bar) =>
  bar.fillIn('Search', 'tickets').clickButton('Apply').assertText('Filter applied'),
)
```

`assertExactText` and the attribute assertions check the current scope, so
pair them with `within`; they take `{ timeout }`:

```ts
await session.within('.total', (t) =>
  t.assertExactText('Total: 1').assertAttribute('data-ready').refuteAttribute('data-loading'),
)
```

What jsdom cannot do throws rather than passing quietly. `visit`,
`assertPath`, `refutePath`, `assertHas` and `refuteHas` throw: there is no
URL bar in jsdom. `reload`, `assertComputedStyle`,
`assertNoHorizontalOverflow`, `assertHorizontalOverflow`,
`assertHorizontallyContained` and `scrollToHorizontalEnd` throw core's
`BrowserOnlyVerbError`: they need a browser, so put them in a Playwright spec.

Secrets: the chain and its failure report never print a `fillIn` or
`assertValue` value: it shows as `'••••••'` (`''` when empty), secret or not.
`debug()` hides password inputs' values the same way.

Four verbs are deliberately adapted to app markup rather than textbook markup:

| Verb | Adapted behaviour |
|------|-------------------|
| `fillIn` and every other label-addressed verb (`selectOption`, `check`/`uncheck`/`choose`, `upload`, `assertValue`, `assertChecked`, `assertSelected`, `assertOptions`) | Finds the control by, in order: a `<label>` that names it — through `htmlFor`, by nesting it (`<label>Store<select>…</select></label>`), or as a **sibling** inside a wrapper `<div>` with no `htmlFor`; its own `aria-label`; its `aria-labelledby`; then its placeholder. A label's name is its own text: the options of a nested select and the text of a button inside it (a help "?") are left out, and so is a trailing required marker (`Subject *`). `aria-label` and `aria-labelledby` count only on form controls. `fillIn` also accepts a number |
| `choose` | By label, for the same reason: a radio with a sibling label has no accessible name |
| `clickButton` / `clickLink` / `click` | Exact visible text first, then text that *contains* the name — an ordered fallback, so the lookup is never ambiguous. `clickButton` then tries a button's `aria-label` (a "Tick all" button labelled "Tick all in the list"), and refuses a disabled button rather than clicking into the void |
| `assertText` / `refuteText` | Containment checks over the rendered text, so `assertText('TICK-')` can assert a generated id's prefix. Both wait within the step's budget: `refuteText` passes as soon as the text is gone, and fails after the budget saying it is `still present` |

Failures print the whole chain:

```
feather-testing-core: Step 3 of 4 failed

Failed at: clickButton('Save')
Cause: Button "Save" is disabled — a user could not click it

Chain:
    [ok] fillIn('Title', '••••••')
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

`feather-testing-core` comes along as a dependency — it is where the Session
DSL lives.

Peer dependencies: `vitest` (always), plus `react`, `react-dom`,
`@tanstack/react-query`, `@tanstack/react-router`, and
`@testing-library/{dom,react,user-event}` for the `/react` and `/session`
entry points (optional for server-only usage). The package ships TypeScript
source — vitest transforms it natively, so no build step is involved.

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

The sandbox suite needs a throwaway database; it creates and drops its own
tables inside it:

```bash
createdb feather_harness_test
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/feather_harness_test npm test
```

That URL is also the default, so `npm test` works once the database exists.
Never point it at a database you care about — the suite drops its tables on
the way in and out.
