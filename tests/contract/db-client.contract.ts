// The client drizzle runs a test's queries on (its session's client; db.$client
// itself is hidden) is an adapter of our own, like raw: nothing reachable from
// it is a driver object, and every path through it refuses once the test ended.
import { createFeatherDb, type PostgresDriver } from '../../src/engine'
import { ENGINE, MIGRATIONS, type RunnerApi } from './runner'
import { ENDED, foreignReachable, ownSurface, refused } from './reflection'

type Variant = { label: string; driver?: PostgresDriver }

export function dbClientContract({ describe, test, expect }: RunnerApi) {
  const variants: Variant[] =
    ENGINE === 'pglite'
      ? [{ label: 'pglite' }]
      : (globalThis as any).Bun
        ? [{ label: 'bun', driver: 'bun' }, { label: 'postgres-js', driver: 'postgres-js' }]
        : [{ label: 'postgres-js', driver: 'postgres-js' }]

  describe(`drizzle's session client (${ENGINE})`, () => {
    for (const v of variants) {
      test(`no driver object is reachable from the session client (${v.label})`, async () => {
        const fdb = createFeatherDb({ driver: v.driver, migrations: MIGRATIONS })
        try {
          const t = await fdb.beginTest()
          const client = (t.db as any).session.client
          const children: object[] = []
          // the client drizzle hands a transaction (its session's client)
          await t.db.transaction(async (tx: any) => {
            children.push(tx.session.client)
          })
          const roots = [client, ...children]
          expect(Object.isFrozen(client)).toBe(true)
          expect(Reflect.ownKeys(client).filter((k) => typeof k === 'symbol')).toEqual([])
          expect(foreignReachable(roots, ownSurface(roots))).toEqual([])
          await fdb.endTest()
        } finally {
          await fdb.close()
        }
      }, 30_000)

      test(`every path through the session client refuses after endTest; nothing persists (${v.label})`, async () => {
        const fdb = createFeatherDb({ driver: v.driver, migrations: MIGRATIONS })
        try {
          const t = await fdb.beginTest()
          const c = (t.db as any).session.client
          const kept: Record<string, any> = {}
          await t.db.transaction(async (tx: any) => {
            kept.child = tx.session.client
          })
          const method = c.unsafe ? 'unsafe' : 'query'
          kept.descriptor = Object.getOwnPropertyDescriptor(c, method)!.value
          kept.bound = c[method].bind(c)
          await fdb.endTest()

          const insert = (title: string) => `insert into todos (title) values ('${title}')`
          const outcomes: Record<string, string> = {
            direct: await refused(() => c[method](insert('direct'), [])),
            descriptor: await refused(() => kept.descriptor(insert('descriptor'), [])),
            descriptorCall: await refused(() => kept.descriptor.call(c, insert('descriptorCall'), [])),
            bound: await refused(() => kept.bound(insert('bound'), [])),
            child: await refused(() => kept.child[method](insert('child'), [])),
          }
          if (c.unsafe) {
            outcomes.values = await refused(() => c.unsafe(insert('values'), []).values())
            outcomes.savepoint = await refused(() => c.savepoint(async () => {}))
            outcomes.begin = await refused(() => c.begin(async () => {}))
          } else {
            outcomes.exec = await refused(() => c.exec(insert('exec')))
            outcomes.transaction = await refused(() => c.transaction(async () => {}))
          }
          for (const [form, o] of Object.entries(outcomes)) expect([form, o]).toEqual([form, expect.stringMatching(ENDED)])

          const fresh = await fdb.beginTest()
          const [{ n }] = await fresh.sql<{ n: number }>`select count(*)::int as n from todos`
          expect(n).toBe(0)
          await fdb.endTest()
        } finally {
          await fdb.close()
        }
      }, 30_000)
    }
  })
}
