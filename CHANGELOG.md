# Changelog

Releases follow [semantic versioning](https://semver.org/).

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
