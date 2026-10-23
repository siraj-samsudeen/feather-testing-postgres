// migrateOnce(folder) applies a folder once, even when called concurrently.
import { createFeatherDb, type IsolationStrategy } from '../../src/engine'
import { ENGINE, MIGRATIONS, type RunnerApi } from './runner'

export function migrateOnceContract({ describe, test, expect }: RunnerApi) {
  describe(`migrateOnce (${ENGINE})`, () => {
    // clone: a fresh template on Postgres; tx on PGlite: a fresh instance
    const strategies: IsolationStrategy[] = ENGINE === 'postgres' ? ['clone'] : ['tx', 'clone']
    for (const strategy of strategies)
      test(`concurrent calls for one folder migrate once (${strategy})`, async () => {
        const fdb = createFeatherDb({ strategy })
        try {
          await fdb.start()
          await Promise.all([fdb.migrateOnce(MIGRATIONS), fdb.migrateOnce(MIGRATIONS), fdb.migrateOnce(MIGRATIONS)])
          const t = await fdb.beginTest()
          const [{ n }] = await t.sql<{ n: number }>`select count(*)::int as n from users`
          expect(n).toBe(0)
          await fdb.endTest()
        } finally {
          await fdb.close()
        }
      }, 30_000)

    test('a failed migration is not cached: the next call retries', async () => {
      const fdb = createFeatherDb({ strategy: 'clone' })
      try {
        await fdb.start()
        await expect(fdb.migrateOnce('/nonexistent/migrations')).rejects.toThrow()
        await expect(fdb.migrateOnce('/nonexistent/migrations')).rejects.toThrow()
      } finally {
        await fdb.close()
      }
    }, 30_000)
  })
}
