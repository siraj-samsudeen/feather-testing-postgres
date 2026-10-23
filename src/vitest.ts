// The engines as Vitest `test.extend` fixtures (Vitest >= 3.2 for file scope).
// A test names what it needs; only that is set up:
//
//   const test = createDbTest({ migrations: './drizzle' })
//   test('lists todos', async ({ db }) => { const app = createApp({ db }); ... })

import { test as base } from 'vitest'
import type { FeatherDb, FeatherDbOptions, SqlRunner, TestDb } from './engine'
import { postgresFixtures, type DbTestFixtures } from './fixtures'

export type { DbTestFixtures } from './fixtures'

export function createDbTest<TDb = any>(options: FeatherDbOptions | FeatherDb<TDb> = {}) {
  // The same definitions as everywhere else; Vitest takes the Playwright shape
  // too (it reads dependencies from each function's destructuring), minus the
  // `deps` option it doesn't know.
  const f = postgresFixtures<TDb>(options)
  const defs = Object.fromEntries(
    Object.entries(f).map(([k, [fn, { scope }]]) => [k, [fn, { scope: scope === 'file' ? 'file' : 'test' }]]),
  )
  return base.extend<DbTestFixtures<TDb>>(defs as never)
}
