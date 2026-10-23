// A clone's pool is big enough for concurrent app transactions (default 10,
// `poolMax` to change it). Postgres only: PGlite is one connection by design.
import { createFeatherDb, type PostgresDriver } from '../../src/engine'
import { todos } from '../fixtures/schema'
import { ENGINE, MIGRATIONS, type RunnerApi } from './runner'

export function clonePoolContract({ describe, test, expect }: RunnerApi) {
  if (ENGINE !== 'postgres') return
  const drivers: PostgresDriver[] = (globalThis as any).Bun ? ['bun', 'postgres-js'] : ['postgres-js']

  /** n transactions that each hold a connection until all n have started. */
  async function concurrentTransactions(db: any, n: number): Promise<number> {
    let started = 0
    let release!: () => void
    const allStarted = new Promise<void>((r) => (release = r))
    await Promise.all(
      Array.from({ length: n }, (_, i) =>
        db.transaction(async (tx: any) => {
          await tx.insert(todos).values({ title: `t${i}` })
          if (++started === n) release()
          await allStarted
        }),
      ),
    )
    return started
  }

  describe('clone pool size', () => {
    for (const driver of drivers) {
      test(`five concurrent transactions don't deadlock by default (${driver})`, async () => {
        const fdb = createFeatherDb({ driver, strategy: 'clone', migrations: MIGRATIONS })
        try {
          const { db } = await fdb.beginTest()
          expect(await concurrentTransactions(db, 5)).toBe(5)
          await fdb.endTest()
        } finally {
          await fdb.close()
        }
      }, 10_000)

      test(`poolMax sets the pool size (${driver})`, async () => {
        const fdb = createFeatherDb({ driver, strategy: 'clone', migrations: MIGRATIONS, poolMax: 6 })
        try {
          const { db, sql } = await fdb.beginTest()
          expect(await concurrentTransactions(db, 6)).toBe(6)
          const [{ n }] = await sql<{ n: number }>`
            select count(*)::int as n from pg_stat_activity where datname = current_database()`
          expect(n).toBeLessThanOrEqual(6)
          await fdb.endTest()
        } finally {
          await fdb.close()
        }
      }, 10_000)
    }
  })
}
