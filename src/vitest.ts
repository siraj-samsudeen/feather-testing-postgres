// The engines as Vitest `test.extend` fixtures (Vitest >= 3.2 for file scope).
// A test names what it needs; only that is set up:
//
//   const test = createDbTest({ migrations: './drizzle' })
//   test('lists todos', async ({ db }) => { const app = createApp({ db }); ... })

import { test as base } from 'vitest'
import type { FeatherDb, FeatherDbOptions, SqlRunner, TestDb } from './engine'
import { postgresFixtures } from './fixtures'

export interface DbTestFixtures<TDb = any> {
  dbEngine: FeatherDb<TDb>
  testDb: TestDb<TDb>
  db: TDb
  sql: SqlRunner
}

export function createDbTest<TDb = any>(options: FeatherDbOptions | FeatherDb<TDb> = {}) {
  const f = postgresFixtures<TDb>(options)
  // Vitest reads each fixture's dependencies from its destructuring pattern,
  // so the definitions are spelled out rather than generated.
  return base.extend<DbTestFixtures<TDb>>({
    dbEngine: [
      // eslint-disable-next-line no-empty-pattern
      async ({}, use) => {
        const fdb = await f.dbEngine.setup({})
        try {
          await use(fdb)
        } finally {
          await f.dbEngine.teardown!(fdb, {})
        }
      },
      { scope: 'file' },
    ],
    testDb: async ({ dbEngine }, use) => {
      const t = await f.testDb.setup({ dbEngine })
      try {
        await use(t)
      } finally {
        await f.testDb.teardown!(t, { dbEngine })
      }
    },
    // Annotated: a generic TDb defeats Vitest's contextual typing.
    db: async ({ testDb }: { testDb: TestDb<TDb> }, use: (v: TDb) => Promise<void>) => {
      await use(testDb.db)
    },
    sql: async ({ testDb }: { testDb: TestDb<TDb> }, use: (v: SqlRunner) => Promise<void>) => {
      await use(testDb.sql)
    },
  })
}
