// The clone strategy gets the same end-of-test guard as tx: work in flight
// when endTest starts finishes (bounded by endTestGraceMs) before the clone is
// closed, and every path through db, sql, drizzle's client and raw refuses
// afterwards.
import { sql as dsql } from 'drizzle-orm'
import { createFeatherDb, type PostgresDriver, type RawSql } from '../../src/engine'
import { todos } from '../fixtures/schema'
import { ENGINE, MIGRATIONS, type RunnerApi } from './runner'
import { ENDED, refused } from './reflection'

type Variant = { label: string; driver?: PostgresDriver }

export function cloneTeardownContract({ describe, test, expect }: RunnerApi) {
  const variants: Variant[] =
    ENGINE === 'pglite'
      ? [{ label: 'pglite' }]
      : (globalThis as any).Bun
        ? [{ label: 'bun', driver: 'bun' }, { label: 'postgres-js', driver: 'postgres-js' }]
        : [{ label: 'postgres-js', driver: 'postgres-js' }]
  const engine = (v: Variant, grace = 2000) =>
    createFeatherDb({ driver: v.driver, strategy: 'clone', migrations: MIGRATIONS, endTestGraceMs: grace })

  describe(`clone teardown (${ENGINE})`, () => {
    for (const v of variants) {
      test(`sql and db.execute in flight at endTest finish; endTest returns (${v.label})`, async () => {
        const fdb = engine(v)
        try {
          const { db, sql } = await fdb.beginTest()
          const late = sql`select 1 as n`.then((r) => r.length, (e: unknown) => String(e))
          const lateDb = db.execute(dsql`select 2 as n`).then(() => 'ran', (e: unknown) => String(e))
          const started = performance.now()
          await fdb.endTest()
          expect(performance.now() - started).toBeLessThan(3000)
          expect(await late).toBe(1)
          expect(await lateDb).toBe('ran')
        } finally {
          await fdb.close()
        }
      }, 20_000)

      test(`every path refuses after endTest (${v.label})`, async () => {
        const fdb = engine(v)
        try {
          const t = await fdb.beginTest()
          const db = t.db as any
          const raw = t.raw as RawSql
          const kept: Record<string, any> = {}
          await db.transaction(async (tx: any) => {
            kept.tx = tx
          })
          await raw.begin(async (child) => {
            kept.rawChild = child
          })
          kept.client = db.session.client
          await fdb.endTest()

          const insert = (title: string) => `insert into todos (title) values ('${title}')`
          const outcomes: Record<string, string> = {
            sql: await refused(() => t.sql`select 1`),
            sqlUnsafe: await refused(() => t.sql.unsafe(insert('sqlUnsafe'))),
            dbSelect: await refused(() => db.select().from(todos)),
            dbInsert: await refused(() => db.insert(todos).values({ title: 'dbInsert' })),
            dbExecute: await refused(() => db.execute(dsql`select 1`)),
            dbTransaction: await refused(() => db.transaction(async () => {})),
            savedTx: await refused(() => kept.tx.insert(todos).values({ title: 'savedTx' })),
            raw: await refused(() => raw`select 1`),
            rawUnsafe: await refused(() => raw.unsafe(insert('rawUnsafe'))),
            rawBegin: await refused(() => raw.begin(async () => {})),
            rawChild: await refused(() => kept.rawChild`select 1`),
          }
          if (kept.client.unsafe) {
            outcomes.clientUnsafe = await refused(() => kept.client.unsafe(insert('clientUnsafe'), []))
            outcomes.clientBegin = await refused(() => kept.client.begin(async () => {}))
          } else {
            outcomes.clientQuery = await refused(() => kept.client.query(insert('clientQuery')))
            outcomes.clientTransaction = await refused(() => kept.client.transaction(async () => {}))
          }
          for (const [form, o] of Object.entries(outcomes)) expect([form, o]).toEqual([form, expect.stringMatching(ENDED)])

          const fresh = await fdb.beginTest()
          const [{ n }] = await fresh.sql<{ n: number }>`select count(*)::int as n from todos`
          expect(n).toBe(0)
          await fdb.endTest()
        } finally {
          await fdb.close()
        }
      }, 20_000)

      test(`a transaction suspended past the grace doesn't hang endTest; its late write is refused (${v.label})`, async () => {
        const grace = 200
        const fdb = engine(v, grace)
        try {
          const { db } = await fdb.beginTest()
          let resume!: () => void
          const paused = new Promise<void>((r) => (resume = r))
          let wrote!: () => void
          const written = new Promise<void>((r) => (wrote = r))
          let lateWrite!: (o: string) => void
          const lateOutcome = new Promise<string>((r) => (lateWrite = r))
          const suspended = (db as any)
            .transaction(async (tx: any) => {
              await tx.insert(todos).values({ title: 'before the end' })
              wrote()
              await paused
              lateWrite(await refused(() => tx.insert(todos).values({ title: 'after the end' })))
            })
            .then(() => 'ran', (e: unknown) => String(e))
          await written
          const started = performance.now()
          await fdb.endTest()
          expect(performance.now() - started).toBeLessThan(grace + 3000)
          resume()
          expect(await lateOutcome).toMatch(ENDED)
          expect(await suspended).not.toBe('ran')
        } finally {
          await fdb.close()
        }
      }, 20_000)
    }
  })
}
