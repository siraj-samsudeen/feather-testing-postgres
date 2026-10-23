// No path from a guarded raw handle yields an unguarded executable: functions
// derived from it (bound, destructured, reached via .call/.apply, nested) and
// every function member it exposes refuse once the test has ended.
import { createFeatherDb, type PostgresDriver } from '../../src/engine'
import { ENGINE, MIGRATIONS, type RunnerApi } from './runner'

const tpl = (s: TemplateStringsArray) => s
const insert = (title: string) =>
  // a real TemplateStringsArray (drivers check .raw)
  ({ call: tpl`insert into todos (title) values ('via call')`, apply: tpl`insert into todos (title) values ('via apply')` })[
    title as 'call' | 'apply'
  ]

function functionMembers(x: any): string[] {
  const names = new Set<string>()
  for (let o = x; o && o !== Object.prototype; o = Object.getPrototypeOf(o))
    for (const k of Reflect.ownKeys(o))
      if (typeof k === 'string' && k !== 'constructor' && k !== 'caller' && k !== 'arguments') names.add(k)
  return [...names].filter((k) => {
    try {
      return typeof x[k] === 'function'
    } catch {
      return false
    }
  })
}

export function rawEscapePathsContract({ describe, test, expect }: RunnerApi) {
  if (ENGINE !== 'postgres') return
  const drivers: PostgresDriver[] = (globalThis as any).Bun ? ['bun', 'postgres-js'] : ['postgres-js']
  const refused = (fn: () => unknown) =>
    Promise.resolve()
      .then(fn)
      .then(
        () => 'ran',
        (e: unknown) => String(e),
      )

  describe('raw handle escape paths after endTest', () => {
    for (const driver of drivers)
      test(`derived functions and every function member refuse (${driver})`, async () => {
        const fdb = createFeatherDb({ driver, migrations: MIGRATIONS })
        try {
          const t = await fdb.beginTest()
          const raw = t.raw as any
          const derived: Record<string, any> = {}
          let saved: any
          await raw.savepoint(async (child: any) => {
            saved = child
            derived.bound = child.bind(null)
            derived.boundUnsafe = child.unsafe.bind(child)
            derived.destructuredUnsafe = child.unsafe
            await child.savepoint(async (grandchild: any) => {
              derived.nestedBound = grandchild.bind(null)
            })
          })
          derived.rawBound = raw.bind(null)
          await fdb.endTest()

          const outcomes: Record<string, string> = {
            bound: await refused(() => derived.bound`insert into todos (title) values ('bound')`),
            boundUnsafe: await refused(() => derived.boundUnsafe("insert into todos (title) values ('boundUnsafe')")),
            destructuredUnsafe: await refused(() =>
              derived.destructuredUnsafe.call(saved, "insert into todos (title) values ('destructured')"),
            ),
            nestedBound: await refused(() => derived.nestedBound`insert into todos (title) values ('nested')`),
            rawBound: await refused(() => derived.rawBound`insert into todos (title) values ('rawBound')`),
            viaCall: await refused(() => saved.call(null, insert('call'))),
            viaApply: await refused(() => saved.apply(null, [insert('apply')])),
            tagged: await refused(() => saved`insert into todos (title) values ('tagged')`),
            unsafe: await refused(() => saved.unsafe("insert into todos (title) values ('unsafe')")),
          }
          for (const [form, o] of Object.entries(outcomes)) expect([form, o]).toEqual([form, expect.stringMatching(/this test has ended/)])

          // property-style: every function member, own or inherited, refuses
          const members = functionMembers(saved)
          expect(members.length).toBeGreaterThan(3)
          for (const name of members) {
            const o = await refused(() => saved[name]())
            expect([name, o]).toEqual([name, expect.stringMatching(/this test has ended/)])
          }

          const fresh = await fdb.beginTest()
          const [{ n }] = await fresh.sql<{ n: number }>`select count(*)::int as n from todos`
          expect(n).toBe(0)
          await fdb.endTest()
        } finally {
          await fdb.close()
        }
      }, 30_000)
  })
}
