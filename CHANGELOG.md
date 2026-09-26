# Changelog

Releases follow [semantic versioning](https://semver.org/).

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
