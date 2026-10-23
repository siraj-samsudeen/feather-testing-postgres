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

    // Siblings deeper down: inside one transaction, two concurrent child
    // transactions (via tx, or via the outer db) must not interleave either.
    const commitAndRollback = (open: (fn: (tx: any) => Promise<void>) => Promise<void>, prefix: string) =>
      Promise.allSettled([
        open(async (tx) => {
          await tx.insert(todos).values({ title: `${prefix} rolled back` })
          await tick()
          await tick()
          throw new Error('sibling fails')
        }),
        open(async (tx) => {
          await tick()
          await tx.insert(todos).values({ title: `${prefix} committed` })
        }),
      ]).then((r) => expect(r.map((x) => x.status)).toEqual(['rejected', 'fulfilled']))

    test('depth 1: concurrent tx.transaction() siblings — commit survives a sibling rollback', async () => {
      await t.db.transaction(async (tx: any) => {
        await commitAndRollback((fn) => tx.transaction(fn), 'tx')
      })
      expect(await titles()).toEqual(['tx committed'])
    })

    test('depth 1: concurrent outer db.transaction() calls inside a transaction', async () => {
      await t.db.transaction(async () => {
        await commitAndRollback((fn) => t.db.transaction(fn), 'db')
      })
      expect(await titles()).toEqual(['db committed'])
    })

    test('depth 2: concurrent siblings two levels down', async () => {
      await t.db.transaction(async (tx: any) => {
        await tx.transaction(async (tx2: any) => {
          await tx2.insert(todos).values({ title: 'level 2' })
          await commitAndRollback((fn) => tx2.transaction(fn), 'deep')
        })
      })
      expect(await titles()).toEqual(['level 2', 'deep committed'])
    })

    test('nesting runs immediately inside a queued sibling (no deadlock)', async () => {
      const order: string[] = []
      await Promise.all(
        ['a', 'b'].map((p) =>
          t.db.transaction(async (tx: any) => {
            order.push(`${p} start`)
            await tx.transaction(async (tx2: any) => {
              await tx2.transaction(async (tx3: any) => {
                await tx3.insert(todos).values({ title: `${p} deep` })
              })
            })
            order.push(`${p} end`)
          }),
        ),
      )
      expect(order).toEqual(['a start', 'a end', 'b start', 'b end'])
      expect((await titles()).sort()).toEqual(['a deep', 'b deep'])
    })

    test('a parent does not settle before its children: failing Promise.all leaves the test usable', async () => {
      let bError: unknown
      await expect(
        t.db.transaction(async (tx: any) => {
          await Promise.all([
            tx.transaction(async (a: any) => {
              await a.insert(todos).values({ title: 'A' })
              throw new Error('A fails')
            }),
            tx
              .transaction(async (b: any) => {
                await tick()
                await b.insert(todos).values({ title: 'B' })
              })
              .catch((e: unknown) => {
                bError = e
                throw e
              }),
          ])
        }),
      ).rejects.toThrow('A fails')
      // B either ran to completion inside the parent's savepoint before the
      // parent failed, or was cancelled with a clear error — never left open
      if (bError !== undefined) expect(String(bError)).toMatch(/parent transaction/)
      expect(await titles()).toEqual([])
      // the test's transaction is intact (no 25P02 "current transaction is aborted")
      await t.db.insert(todos).values({ title: 'after' })
      expect(await titles()).toEqual(['after'])
    })

    test('children still queued when their parent fails are cancelled; a running one finishes first', async () => {
      const events: string[] = []
      let cError: unknown
      await expect(
        t.db.transaction(async (tx: any) => {
          await Promise.all([
            tx.transaction(async () => {
              throw new Error('A fails')
            }),
            tx.transaction(async (b: any) => {
              events.push('B start')
              for (let i = 0; i < 5; i++) await tick()
              await b.insert(todos).values({ title: 'B' })
              events.push('B end')
            }),
            tx
              .transaction(async () => {
                events.push('C start')
              })
              .catch((e: unknown) => {
                cError = e
                throw e
              }),
          ])
        }),
      ).rejects.toThrow('A fails')
      expect(events).toEqual(['B start', 'B end'])
      expect(String(cError)).toMatch(/cancelled — its parent transaction failed/)
      expect(await titles()).toEqual([])
      await t.db.insert(todos).values({ title: 'after' })
      expect(await titles()).toEqual(['after'])
    })

    test('a parent that catches a child failure waits for the queued sibling before committing', async () => {
      await t.db.transaction(async (tx: any) => {
        try {
          await Promise.all([
            tx.transaction(async (a: any) => {
              await a.insert(todos).values({ title: 'A' })
              throw new Error('A fails')
            }),
            tx.transaction(async (b: any) => {
              await tick()
              await b.insert(todos).values({ title: 'B' })
            }),
          ])
        } catch {
          // the app recovers; B is still queued or running
        }
      })
      expect(await titles()).toEqual(['B'])
      await t.db.insert(todos).values({ title: 'after' })
      expect(await titles()).toEqual(['B', 'after'])
    })

    test('a plain write while another request’s transaction is open is not swept into its rollback', async () => {
      const results = await Promise.allSettled([
        t.db.transaction(async (tx: any) => {
          await tx.insert(todos).values({ title: 'in the rolled-back transaction' })
          await tick()
          await tick()
          throw new Error('request A fails')
        }),
        (async () => {
          await tick()
          await t.db.insert(todos).values({ title: 'plain write via db' })
        })(),
        (async () => {
          await tick()
          await t.sql`insert into todos (title) values ('plain write via sql')`
        })(),
      ])
      expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled', 'fulfilled'])
      expect((await titles()).sort()).toEqual(['plain write via db', 'plain write via sql'])
    })

    test('a write while a raw savepoint is open is not swept into its rollback', async () => {
      const raw = t.raw
      const results = await Promise.allSettled([
        raw.savepoint(async (c) => {
          await c`insert into todos (title) values ('in the rolled-back raw savepoint')`
          await tick()
          await tick()
          throw new Error('raw work fails')
        }),
        (async () => {
          await tick()
          await t.db.insert(todos).values({ title: 'via db' })
        })(),
        (async () => {
          await tick()
          await t.sql`insert into todos (title) values ('via sql')`
        })(),
        (async () => {
          await tick()
          await raw`insert into todos (title) values ('via raw')`
        })(),
      ])
      expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled', 'fulfilled', 'fulfilled'])
      expect((await titles()).sort()).toEqual(['via db', 'via raw', 'via sql'])
    })

    test('raw savepoints and db transactions nest inside each other (no deadlock)', async () => {
      await t.raw.savepoint(async (c) => {
        await c`insert into todos (title) values ('raw outer')`
        await t.db.transaction(async (tx: any) => {
          await tx.insert(todos).values({ title: 'db inside raw' })
          await t.raw.savepoint(async (c2) => {
            await c2`insert into todos (title) values ('raw inside db')`
          })
        })
        await t.sql`insert into todos (title) values ('sql inside raw')`
      })
      expect((await titles()).sort()).toEqual(['db inside raw', 'raw inside db', 'raw outer', 'sql inside raw'])
    })

    test('the outer db and sql inside a transaction callback run inside it (no deadlock)', async () => {
      await t.db.transaction(async (tx: any) => {
        await tx.insert(todos).values({ title: 'inside' })
        expect((await t.db.select().from(todos)).length).toBe(1)
        const [{ n }] = await t.sql<{ n: number }>`select count(*)::int as n from todos`
        expect(n).toBe(1)
        await tx.transaction(async () => {
          expect((await t.db.select().from(todos)).length).toBe(1)
        })
      })
      expect(await titles()).toEqual(['inside'])
    })

    // Work the app leaves running when the test body returns must never reach
    // the bare connection (where postgres.js would autocommit it).
    const late: { errors: unknown[]; settled: Promise<unknown>[] } = { errors: [], settled: [] }
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

    test('schedules writes that outlive the test (not awaited)', async () => {
      const record = (p: Promise<unknown>) =>
        late.settled.push(p.then(() => late.errors.push('ran'), (e) => late.errors.push(e)))
      const db = t.db
      const sql = t.sql
      record(sleep(30).then(() => db.insert(todos).values({ title: 'late via db' })))
      record(sleep(30).then(() => sql`insert into todos (title) values ('late via sql')`))
      record(
        sleep(30).then(() =>
          db.transaction(async (tx: any) => {
            await tx.insert(todos).values({ title: 'late transaction' })
          }),
        ),
      )
      // ...and one queued behind a transaction still open when the test ends
      record(db.transaction(async (tx: any) => {
        await sleep(30)
        await tx.insert(todos).values({ title: 'open at the end' })
      }))
      record(db.insert(todos).values({ title: 'queued behind it' }))
    })

    test('...are rejected with a clear error, and nothing was committed', async () => {
      await Promise.all(late.settled)
      expect(late.errors.length).toBe(5)
      // drizzle wraps driver errors in DrizzleQueryError, keeping ours as cause
      for (const e of late.errors)
        expect(`${e} ${(e as { cause?: unknown })?.cause}`).toMatch(/this test has ended — a query ran after endTest/)
      const [{ n }] = await t.sql<{ n: number }>`select count(*)::int as n from todos`
      expect(n).toBe(0)
      if (ENGINE === 'postgres') {
        const fresh = createFeatherDb({})
        try {
          const f = await fresh.beginTest()
          const [{ m }] = await f.sql<{ m: number }>`select count(*)::int as m from todos`
          expect(m).toBe(0)
        } finally {
          await fresh.close()
        }
      }
    })

    let inFlight: Promise<unknown> | undefined
    test('an app transaction failing on its own during endTest... (not awaited)', async () => {
      let written!: () => void
      const wrote = new Promise<void>((r) => (written = r))
      inFlight = t.db
        .transaction(async (tx: any) => {
          await tx.insert(todos).values({ title: 'written before the end' })
          written()
          await sleep(30) // the test ends meanwhile
          throw new Error('the app’s own failure')
        })
        .then(
          () => 'resolved',
          (e: unknown) => e,
        )
      await wrote
    })

    test('...surfaces its own error, and its savepoint was rolled back inside the test', async () => {
      const outcome = await inFlight
      expect(String(outcome)).toMatch(/the app’s own failure/)
      const [{ n }] = await t.sql<{ n: number }>`select count(*)::int as n from todos`
      expect(n).toBe(0)
    })

    test('transaction config (isolation level, access mode, deferrable) is accepted and ignored under tx', async () => {
      await t.db.transaction(
        async (tx: any) => {
          await tx.insert(todos).values({ title: 'serializable, as far as the app knows' })
          await tx.transaction(async (tx2: any) => {
            await tx2.insert(todos).values({ title: 'nested' })
          })
        },
        { isolationLevel: 'serializable', accessMode: 'read write', deferrable: true },
      )
      expect((await titles()).sort()).toEqual(['nested', 'serializable, as far as the app knows'])
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
