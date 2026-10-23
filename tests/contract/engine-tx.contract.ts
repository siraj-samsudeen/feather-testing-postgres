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

    // Concurrent requests each opening db.transaction() on the one test
    // handle: their savepoints must not interleave.
    const tick = () => new Promise((r) => setTimeout(r, 2))
    const titles = async () => (await t.db.select().from(todos).orderBy(todos.id)).map((r: any) => r.title)

    test('two concurrent app transactions both commit', async () => {
      await Promise.all(
        ['first', 'second'].map((title) =>
          t.db.transaction(async (tx: any) => {
            await tick()
            await tx.insert(todos).values({ title })
            await tick()
          }),
        ),
      )
      expect((await titles()).sort()).toEqual(['first', 'second'])
    })

    test('a sibling rolling back does not undo a committed sibling', async () => {
      const results = await Promise.allSettled([
        t.db.transaction(async (tx: any) => {
          await tx.insert(todos).values({ title: 'rolled back' })
          await tick()
          await tick()
          throw new Error('A fails')
        }),
        t.db.transaction(async (tx: any) => {
          await tick()
          await tx.insert(todos).values({ title: 'committed' })
        }),
      ])
      expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled'])
      expect(await titles()).toEqual(['committed'])
    })

    test('concurrent siblings with real nesting inside each', async () => {
      await Promise.all(
        ['x', 'y'].map((p) =>
          t.db.transaction(async (tx: any) => {
            await tx.insert(todos).values({ title: `${p}-outer` })
            await tick()
            await tx
              .transaction(async (tx2: any) => {
                await tx2.insert(todos).values({ title: `${p}-inner-dropped` })
                throw new Error('inner')
              })
              .catch(() => {})
            await tx.transaction(async (tx2: any) => {
              await tick()
              await tx2.insert(todos).values({ title: `${p}-inner-kept` })
            })
          }),
        ),
      )
      expect((await titles()).sort()).toEqual(['x-inner-kept', 'x-outer', 'y-inner-kept', 'y-outer'])
    })

    test('an app transaction that calls db.transaction() again (not tx) still nests', async () => {
      await t.db.transaction(async (tx: any) => {
        await tx.insert(todos).values({ title: 'outer' })
        await t.db.transaction(async (tx2: any) => {
          await tx2.insert(todos).values({ title: 'via db' })
        })
      })
      expect(await titles()).toEqual(['outer', 'via db'])
    })

    test('refuses a second open test (sequential tests only)', async () => {
      await expect(fdb.beginTest()).rejects.toThrow(/sequentially/)
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
