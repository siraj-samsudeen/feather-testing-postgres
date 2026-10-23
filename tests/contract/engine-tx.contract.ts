// The `tx` strategy: every test runs inside one transaction that is rolled
// back; the app's own transactions become savepoints inside it.
import { count, eq } from 'drizzle-orm'
import { createFeatherDb, type TestDb } from '../../src/engine'
import { todos, users } from '../fixtures/schema'
import { ENGINE, MIGRATIONS, type RunnerApi } from './runner'

export function engineTxContract({ describe, test, expect, beforeAll, afterAll, beforeEach, afterEach }: RunnerApi) {
  describe(`engine ${ENGINE} / strategy tx`, () => {
    const fdb = createFeatherDb({ migrations: MIGRATIONS })
    let t: TestDb

    beforeAll(() => fdb.start(), 30_000)
    afterAll(() => fdb.close())
    beforeEach(async () => {
      t = await fdb.beginTest()
    })
    afterEach(() => fdb.endTest())

    test('reports the engine and strategy it runs', () => {
      expect(fdb.engine).toBe(ENGINE)
      expect(fdb.strategy).toBe('tx')
    })

    test('writes through db are visible inside the test', async () => {
      await t.db.insert(users).values({ email: 'a@x.test', name: 'A' })
      const [{ n }] = await t.db.select({ n: count() }).from(users)
      expect(n).toBe(1)
    })

    test('...and gone in the next test', async () => {
      const [{ n }] = await t.db.select({ n: count() }).from(users)
      expect(n).toBe(0)
    })

    test('sql runs on the same transaction as db', async () => {
      await t.db.insert(users).values({ email: 'b@x.test', name: 'B' })
      const rows = await t.sql<{ email: string }>`select email from users where name = ${'B'}`
      expect(rows.map((r) => r.email)).toEqual(['b@x.test'])
      const viaUnsafe = await t.sql.unsafe<{ n: number }>('select count(*)::int as n from users where name = $1', ['B'])
      expect(viaUnsafe[0].n).toBe(1)
    })

    test('an app transaction becomes a savepoint: commit keeps, failure rolls back only itself', async () => {
      const [u] = await t.db.insert(users).values({ email: 'c@x.test', name: 'C' }).returning()
      await t.db.transaction(async (tx: any) => {
        await tx.insert(todos).values({ ownerId: u.id, title: 'kept' })
      })
      await expect(
        t.db.transaction(async (tx: any) => {
          await tx.insert(todos).values({ ownerId: u.id, title: 'dropped' })
          // nested app transaction inside an app transaction
          await tx.transaction(async (tx2: any) => {
            await tx2.insert(todos).values({ ownerId: u.id, title: 'dropped too' })
          })
          throw new Error('app failure')
        }),
      ).rejects.toThrow('app failure')
      const titles = (await t.db.select().from(todos).where(eq(todos.ownerId, u.id))).map((r: any) => r.title)
      expect(titles).toEqual(['kept'])
    })

    test('...and none of it reached the database', async () => {
      const [{ n }] = await t.db.select({ n: count() }).from(todos)
      expect(n).toBe(0)
    })

    test('a SQL error inside an app transaction leaves the test transaction usable', async () => {
      await t.db.insert(users).values({ email: 'dup@x.test', name: 'D' })
      await expect(
        t.db.transaction(async (tx: any) => {
          await tx.insert(users).values({ email: 'dup@x.test', name: 'D2' })
        }),
      ).rejects.toThrow()
      const [{ n }] = await t.db.select({ n: count() }).from(users)
      expect(n).toBe(1)
    })

    test('migrateOnce is idempotent', async () => {
      await fdb.migrateOnce(MIGRATIONS)
      const [{ n }] = await t.sql<{ n: number }>`select count(*)::int as n from users`
      expect(n).toBe(0)
    })
  })
}

/** Documented behaviour (README "gaps"): inside one test, now() is frozen. */
export function nowFrozenContract({ describe, test, expect, beforeAll, afterAll, beforeEach, afterEach }: RunnerApi) {
  describe(`now() under tx (${ENGINE})`, () => {
    const fdb = createFeatherDb({})
    let t: TestDb
    beforeAll(() => fdb.start(), 30_000)
    afterAll(() => fdb.close())
    beforeEach(async () => {
      t = await fdb.beginTest()
    })
    afterEach(() => fdb.endTest())
    test('is the transaction start time for the whole test', async () => {
      const [a] = await t.sql<{ ts: string }>`select now()::text as ts`
      await new Promise((r) => setTimeout(r, 5))
      const [b] = await t.sql<{ ts: string }>`select now()::text as ts, clock_timestamp() as c`
      expect(a.ts).toBe(b.ts)
    })
  })
}
