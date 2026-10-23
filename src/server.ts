// createPgTest: a Vitest `test` with Phoenix-style fixtures for a Hono +
// Postgres app. Every test runs inside a rolled-back transaction (see
// sandbox.ts); requests are dispatched in-process via `app.request` — no
// HTTP server, no mocks, real Postgres.

import { test as base } from 'vitest'
import { withSandbox } from './sandbox'
import { makeClient, saveRowSeed, type PgTestBindings, type PgTestFixtures, type PgTestOptions, type TestClient } from './client'

export {
  makeClient,
  saveRowSeed,
  TestApiError,
  type AppLike,
  type CreateUserFn,
  type PgTestBindings,
  type PgTestFixtures,
  type PgTestOptions,
  type SeedCallback,
  type SeedFn,
  type TestClient,
} from './client'

function required<K extends 'mintToken' | 'insertUser'>(
  b: PgTestBindings,
  key: K,
  fixture: string,
): NonNullable<PgTestBindings[K]> {
  const fn = b[key]
  if (!fn)
    throw new Error(`feather-testing-postgres: the '${fixture}' fixture needs \`${key}\` in createPgTest's bindings`)
  // bound: method-style bindings (`mintToken(u) { return this.issueSession(u) }`) keep `this`
  return (fn as Function).bind(b) as NonNullable<PgTestBindings[K]>
}
let userCounter = 0

export function createPgTest(b: PgTestBindings, opts: PgTestOptions = {}) {
  return base.extend<PgTestFixtures>({
    // Auto fixture: EVERY test using this `test` runs sandboxed, whether or
    // not it asks for any other fixture.
    db: [
      // eslint-disable-next-line no-empty-pattern
      async ({}, use) => {
        await withSandbox(b, async (tx) => {
          await use(tx)
        })
      },
      { auto: true },
    ],
    api: async ({ db: _db }, use) => {
      await use(makeClient(b.app, null, null))
    },
    admin: async ({ db: _db }, use) => {
      const usr = b.adminUser ?? 'Administrator'
      await use(makeClient(b.app, await required(b, 'mintToken', 'admin')(usr), usr))
    },
    createUser: async ({ db: _db }, use) => {
      await use(async (o = {}) => {
        const email = o.email ?? `user-${++userCounter}@feather.test`
        const rowId = await required(b, 'insertUser', 'createUser')({
          email,
          fullName: o.fullName,
          roles: o.roles ?? opts.defaultRoles ?? [],
        })
        return makeClient(b.app, await required(b, 'mintToken', 'createUser')(rowId), rowId)
      })
    },
    client: async ({ createUser }, use) => {
      await use(await createUser())
    },
    // \`admin\` is built only when the seed strategy asks for it, so harnesses
    // without auth can still seed.
    seed: async ({ db, api }, use) => {
      const usr = b.adminUser ?? 'Administrator'
      let adminClient: TestClient | undefined
      const admin = async () =>
        (adminClient ??= makeClient(b.app, await required(b, 'mintToken', 'admin')(usr), usr))
      const strategy = b.seed ? b.seed.bind(b) : saveRowSeed
      await use((table, values = {}) => strategy(table, values, { db, api, admin }))
    },
  })
}
