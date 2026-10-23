// bun:test helpers. Standalone — no fixture engine needed:
//
//   const t = sandboxEach({ migrations: './drizzle' })
//   test('lists todos', async () => {
//     const app = createApp({ db: t.db })
//     ...
//   })
//
// bun:test runs files one after another in a single process, and tests in a
// file sequentially — which is what one-transaction-per-test needs. Never use
// test.concurrent with these helpers.

import { afterAll, afterEach, beforeAll, beforeEach } from 'bun:test'
import type { FeatherDb, FeatherDbOptions } from './engine'
import { postgresFixtures, useFixtures } from './fixtures'

export * from './engine'
export {
  postgresFixtures,
  useFixtures,
  type FixtureDef,
  type FixtureFn,
  type FixtureOptions,
  type FixtureScope,
  type FixtureValues,
  type LifecycleHooks,
  type PostgresFixtures,
  type PostgresFixtureValues,
  type Use,
} from './fixtures'

const bunHooks = { beforeAll, afterAll, beforeEach, afterEach }

/** Registers beforeAll/afterAll (engine start + migrations, close) and
 * beforeEach/afterEach (begin/end the test's isolation unit) in the calling
 * file or describe block. Returns live `{ db, sql, testDb, dbEngine }`. */
export function sandboxEach<TDb = any>(options: FeatherDbOptions | FeatherDb<TDb> = {}) {
  return useFixtures(postgresFixtures<TDb>(options), bunHooks)
}

/** useFixtures bound to bun:test hooks, for your own definitions alongside
 * (e.g. `{ ...postgresFixtures(), app: async ({ db }, use) => use(createApp({ db })) }`). */
export function useBunFixtures<F extends object>(defs: F) {
  return useFixtures(defs, bunHooks)
}
