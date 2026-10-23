// db.$client is hidden in tests (author's decision): the driver's client (or
// our adapter) is not part of what a test or the app gets. Reading it throws a
// clear error, reflection doesn't see it, and drizzle keeps working through
// its own session.
import { count, sql as dsql } from 'drizzle-orm'
import { createFeatherDb, type IsolationStrategy, type PostgresDriver } from '../../src/engine'
import { todos, users } from '../fixtures/schema'
import { ENGINE, MIGRATIONS, type RunnerApi } from './runner'
import { reachable } from './reflection'

const HIDDEN = /db\.\$client is not available in tests: use db, sql or raw/

type Variant = { label: string; driver?: PostgresDriver }

/** A driver object: has a driver's query entry point and is not one of our
 * frozen adapters. Members are found through descriptors (getters not run). */
function isDriverObject(o: object): boolean {
  const has = (name: string) => {
    for (let p: object | null = o; p; p = Object.getPrototypeOf(p)) {
      const d = Reflect.getOwnPropertyDescriptor(p, name)
      if (d) return typeof d.value === 'function'
    }
    return false
  }
  const looksLikeDriver = has('unsafe') || (has('query') && has('exec'))
  return looksLikeDriver && !Object.isFrozen(o)
}

export function hiddenClientContract({ describe, test, expect }: RunnerApi) {
  const variants: Variant[] =
    ENGINE === 'pglite'
      ? [{ label: 'pglite' }]
      : (globalThis as any).Bun
        ? [{ label: 'bun', driver: 'bun' }, { label: 'postgres-js', driver: 'postgres-js' }]
        : [{ label: 'postgres-js', driver: 'postgres-js' }]

  describe(`db.$client is hidden (${ENGINE})`, () => {
    for (const v of variants)
      for (const strategy of ['tx', 'clone'] as IsolationStrategy[]) {
        const label = `${v.label}, ${strategy}`

        test(`reading it throws; reflection does not see it (${label})`, async () => {
          const fdb = createFeatherDb({ driver: v.driver, strategy, migrations: MIGRATIONS })
          try {
            const t = await fdb.beginTest()
            const db = t.db as any
            expect(() => db.$client).toThrow(HIDDEN)
            expect('$client' in db).toBe(false)
            expect(Reflect.has(db, '$client')).toBe(false)
            expect(Object.getOwnPropertyDescriptor(db, '$client')).toBeUndefined()
            expect(Object.keys(db)).not.toContain('$client')
            expect(Reflect.ownKeys(db)).not.toContain('$client')
            expect('$client' in { ...db }).toBe(false)
            await db.transaction(async (tx: any) => {
              expect(() => tx.$client).toThrow(HIDDEN)
              expect('$client' in tx).toBe(false)
              await tx.transaction(async (tx2: any) => {
                expect(() => tx2.$client).toThrow(HIDDEN)
              })
            })
            // under tx, nothing reachable from db by reflection is a driver object
            // (drizzle's session holds our frozen adapter). A clone's db is plain
            // drizzle over a real connection: its session holds the driver.
            if (strategy === 'tx') expect([...reachable([db])].filter(isDriverObject)).toEqual([])
            await fdb.endTest()
          } finally {
            await fdb.close()
          }
        }, 30_000)

        test(`drizzle keeps working through its session (${label})`, async () => {
          const fdb = createFeatherDb({ driver: v.driver, strategy, migrations: MIGRATIONS, schema: { users, todos } })
          try {
            const t = await fdb.beginTest()
            const db = t.db as any
            const [u] = await db.insert(users).values({ email: 'a@x.test', name: 'A' }).returning()
            await db.transaction(async (tx: any) => {
              await tx.insert(todos).values({ title: 'outer', ownerId: u.id })
              await tx.transaction(async (tx2: any) => {
                await tx2.insert(todos).values({ title: 'nested', ownerId: u.id })
              })
            })
            expect((await db.select().from(todos)).map((r: any) => r.title).sort()).toEqual(['nested', 'outer'])
            const executed = await db.execute(dsql`select count(*)::int as n from todos`)
            expect(Array.from((executed as any).rows ?? executed)[0]).toMatchObject({ n: 2 })
            expect(await db.$count(todos)).toBe(2)
            const [{ n }] = await db.select({ n: count() }).from(users)
            expect(n).toBe(1)
            expect((await db.query.users.findMany()).map((r: any) => r.email)).toEqual(['a@x.test'])
            await fdb.endTest()
          } finally {
            await fdb.close()
          }
        }, 30_000)

        test(`the round-10 lost-write reproduction cannot be written (${label})`, async () => {
          const fdb = createFeatherDb({ driver: v.driver, strategy, migrations: MIGRATIONS })
          try {
            const t = await fdb.beginTest()
            const db = t.db as any
            // was: db.$client.savepoint(...) / db.$client.transaction(...) beside a write
            expect(() => db.$client.savepoint).toThrow(HIDDEN)
            expect(() => db.$client.transaction).toThrow(HIDDEN)
            await fdb.endTest()
          } finally {
            await fdb.close()
          }
        }, 30_000)
      }
  })
}
