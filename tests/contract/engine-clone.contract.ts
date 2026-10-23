// The `clone` strategy: a fresh database per test, copied from a migrated
// template. Nothing is wrapped in a transaction, so COMMIT is real.
import { count } from 'drizzle-orm'
import { createFeatherDb, type TestDb } from '../../src/engine'
import { users } from '../fixtures/schema'
import { ENGINE, MIGRATIONS, type RunnerApi } from './runner'

export function engineCloneContract({ describe, test, expect, beforeAll, afterAll, beforeEach, afterEach }: RunnerApi) {
  describe(`engine ${ENGINE} / strategy clone`, () => {
    const fdb = createFeatherDb({
      strategy: 'clone',
      migrations: MIGRATIONS,
      // runs once, on the template: every clone starts with this row
      setup: (sql) => sql`insert into users (email, name) values ('seed@x.test', 'Seed')`,
    })
    let t: TestDb
    const seen = new Set<string>()

    beforeAll(() => fdb.start(), 60_000)
    afterAll(() => fdb.close(), 30_000)
    beforeEach(async () => {
      t = await fdb.beginTest()
    }, 30_000)
    afterEach(() => fdb.endTest(), 30_000)

    test('reports the strategy', () => {
      expect(fdb.strategy).toBe('clone')
    })

    test('each test starts from the template: migrated, set up, nothing else', async () => {
      const rows = await t.db.select().from(users)
      expect(rows.map((r: any) => r.email)).toEqual(['seed@x.test'])
      await t.db.insert(users).values({ email: 'gone@x.test', name: 'Gone' })
    })

    test('...so the previous test’s writes are gone', async () => {
      const [{ n }] = await t.db.select({ n: count() }).from(users)
      expect(n).toBe(1)
    })

    test('an app transaction really commits (not a savepoint)', async () => {
      await t.db.transaction(async (tx: any) => {
        await tx.insert(users).values({ email: 'c@x.test', name: 'C' })
      })
      // outside any transaction: two statements see different now() values,
      // which never happens inside a single test transaction
      const [a] = await t.sql<{ ts: string }>`select now()::text as ts`
      await new Promise((r) => setTimeout(r, 5))
      const [b] = await t.sql<{ ts: string }>`select now()::text as ts`
      expect(a.ts).not.toBe(b.ts)
      const open = await t.sql.unsafe<{ s: string }>("select current_setting('transaction_isolation') as s")
      expect(open.length).toBe(1)
    })

    if (ENGINE === 'postgres')
      test('each test gets its own database', async () => {
        for (let i = 0; i < 2; i++) {
          const [{ db }] = await t.sql<{ db: string }>`select current_database() as db`
          seen.add(db)
          await fdb.endTest()
          t = await fdb.beginTest()
        }
        expect(seen.size).toBe(2)
        for (const name of seen) expect(name).toMatch(/^feather_t_/)
      })
  })
}
