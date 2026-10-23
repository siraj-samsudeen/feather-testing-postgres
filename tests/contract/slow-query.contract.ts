// Bun.sql: a slow query still running when endTestGraceMs expires does not
// stop endTest from finishing, and the next test is clean. Needs a Postgres
// server (the postgres lane under bun); skipped otherwise.
import { createFeatherDb } from '../../src/engine'
import { todos } from '../fixtures/schema'
import { ENGINE, MIGRATIONS, type RunnerApi } from './runner'

export function slowQueryContract({ describe, test, expect }: RunnerApi) {
  if (ENGINE !== 'postgres' || !(globalThis as any).Bun) return
  describe('Bun.sql: a slow query in flight at endTest', () => {
    test('endTest still finishes; the next test is clean', async () => {
      const fdb = createFeatherDb({ driver: 'bun', migrations: MIGRATIONS, endTestGraceMs: 200 })
      try {
        const t = await fdb.beginTest()
        await t.db.insert(todos).values({ title: 'rolled back' })
        const slow = t.sql`select pg_sleep(2)`.then(
          () => 'finished',
          (e: unknown) => String(e),
        )
        await new Promise((r) => setTimeout(r, 50)) // really running
        const started = performance.now()
        await fdb.endTest()
        expect(performance.now() - started).toBeLessThan(6000)
        await slow

        const next = await fdb.beginTest()
        const [{ n }] = await next.sql<{ n: number }>`select count(*)::int as n from todos`
        expect(n).toBe(0)
        await next.db.insert(todos).values({ title: 'next test' })
        await fdb.endTest()
      } finally {
        await fdb.close()
      }
    }, 20_000)
  })
}
