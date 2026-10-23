// `raw` is a frozen facade of our own, never a driver object: a fixed API
// (raw`...`, unsafe, savepoint, begin, and cursor on postgres.js) whose every
// method checks the end-of-test guard, returns plain data, and hands callbacks
// another facade. These tests try every reflection path a test could use to
// reach a driver object or run a query after endTest.
import { createFeatherDb, type FeatherDb, type PostgresDriver, type RawSql } from '../../src/engine'
import { ENGINE, MIGRATIONS, type RunnerApi } from './runner'
import { BUILTIN, ENDED, reachable, refused } from './reflection'

type Variant = { label: string; driver?: PostgresDriver }

export function rawFacadeContract({ describe, test, expect }: RunnerApi) {
  const variants: Variant[] =
    ENGINE === 'pglite'
      ? [{ label: 'pglite' }]
      : (globalThis as any).Bun
        ? [{ label: 'bun', driver: 'bun' }, { label: 'postgres-js', driver: 'postgres-js' }]
        : [{ label: 'postgres-js', driver: 'postgres-js' }]

  const engine = (v: Variant, extra: object = {}) =>
    createFeatherDb({ driver: v.driver, migrations: MIGRATIONS, ...extra })

  async function freshCount(fdb: FeatherDb): Promise<number> {
    const t = await fdb.beginTest()
    const [{ n }] = await t.sql<{ n: number }>`select count(*)::int as n from todos`
    await fdb.endTest()
    return n
  }

  describe(`raw facade (${ENGINE})`, () => {
    for (const v of variants) {
      test(`offers the documented API, returning plain data (${v.label})`, async () => {
        const fdb = engine(v)
        try {
          const t = await fdb.beginTest()
          const raw = t.raw as RawSql
          expect(Object.isFrozen(raw)).toBe(true)
          const rows = await raw<{ n: number }>`select ${41}::int + 1 as n`
          expect(rows).toEqual([{ n: 42 }])
          expect(Object.getPrototypeOf(rows)).toBe(Array.prototype)
          expect(await raw.unsafe<{ n: number }>('select $1::int as n', [7])).toEqual([{ n: 7 }])

          await raw.savepoint(async (child) => {
            await child`insert into todos (title) values ('kept')`
          })
          await expect(
            raw.begin(async (child) => {
              await child`insert into todos (title) values ('rolled back')`
              await child.savepoint(async (grandchild) => {
                await grandchild`insert into todos (title) values ('nested, rolled back with its parent')`
              })
              throw new Error('app failure')
            }),
          ).rejects.toThrow('app failure')
          expect((await raw<{ title: string }>`select title from todos`).map((r) => r.title)).toEqual(['kept'])

          if (v.driver === 'postgres-js') {
            const batches: number[][] = []
            for await (const batch of raw.cursor!<{ g: number }>('select generate_series(1, 5) as g', [], 2))
              batches.push(batch.map((r) => r.g))
            expect(batches).toEqual([[1, 2], [3, 4], [5]])
          } else expect(raw.cursor).toBeUndefined()
          await fdb.endTest()
        } finally {
          await fdb.close()
        }
      }, 30_000)

      if (v.driver === 'postgres-js')
        test(`an abandoned cursor does not hang endTest; the next test is isolated (${v.label})`, async () => {
          const grace = 500
          const fdb = engine(v, { endTestGraceMs: grace })
          try {
            const t = await fdb.beginTest()
            const raw = t.raw as RawSql
            await raw`insert into todos (title) values ('this test only')`
            const it = raw.cursor!('select generate_series(1, 10) as g', [], 1)[Symbol.asyncIterator]()
            expect((await it.next()).value).toEqual([{ g: 1 }]) // one batch read, then abandoned
            const started = performance.now()
            await fdb.endTest()
            expect(performance.now() - started).toBeLessThan(grace + 1000)

            const next = await fdb.beginTest()
            await next.raw`insert into todos (title) values ('next test')`
            const titles = (await next.raw<{ title: string }>`select title from todos`).map((r) => r.title)
            expect(titles).toEqual(['next test'])
            await fdb.endTest()
          } finally {
            await fdb.close()
          }
        }, 10_000)

      test(`no driver object is reachable from a facade by reflection (${v.label})`, async () => {
        const fdb = engine(v)
        try {
          const t = await fdb.beginTest()
          const raw = t.raw as RawSql
          let child!: RawSql
          await raw.savepoint(async (c) => {
            child = c
          })
          const ours = new Set<object>()
          for (const f of [raw, child]) {
            ours.add(f)
            for (const k of Reflect.ownKeys(f)) {
              const d = Reflect.getOwnPropertyDescriptor(f, k)!
              for (const x of [d.value, d.get, d.set]) if (x && typeof x === 'function') ours.add(x)
            }
          }
          const foreign = [...reachable([raw, child])].filter((o) => !BUILTIN.has(o) && !ours.has(o))
          expect(foreign).toEqual([])
          // and our own functions expose nothing but name/length
          for (const f of ours)
            for (const k of Reflect.ownKeys(f)) expect(['length', 'name', 'unsafe', 'savepoint', 'begin', 'cursor']).toContain(k)
          await fdb.endTest()
        } finally {
          await fdb.close()
        }
      }, 30_000)

      test(`every path refuses after endTest and nothing persists (${v.label})`, async () => {
        const fdb = engine(v, { endTestGraceMs: 100 })
        try {
          const t = await fdb.beginTest()
          const raw = t.raw as RawSql
          const kept: Record<string, any> = {}
          await raw.savepoint(async (child) => {
            kept.child = child
            kept.bound = child.bind(null)
            kept.boundUnsafe = child.unsafe.bind(child)
            kept.destructuredUnsafe = child.unsafe
            await child.savepoint(async (grandchild) => {
              kept.grandchild = grandchild
            })
          })
          // a callback nested in an argument array, reached via .apply
          await raw.savepoint.apply(raw, [
            async (c: RawSql) => {
              kept.viaApply = c
            },
          ])
          kept.descriptorUnsafe = Object.getOwnPropertyDescriptor(raw, 'unsafe')!.value
          kept.descriptorSavepoint = Object.getOwnPropertyDescriptor(raw, 'savepoint')!.value
          kept.symbolValues = Reflect.ownKeys(raw)
            .filter((k) => typeof k === 'symbol')
            .map((k) => (raw as any)[k])
          if (raw.cursor) {
            kept.cursor = raw.cursor("insert into todos (title) values ('cursor') returning id")
            kept.iterator = raw.cursor("insert into todos (title) values ('iterator') returning id")[Symbol.asyncIterator]()
          }
          // a savepoint suspended across the end, writing when it resumes
          let resume!: () => void
          const paused = new Promise<void>((r) => (resume = r))
          let lateWrite!: (o: string) => void
          const lateWriteOutcome = new Promise<string>((r) => (lateWrite = r))
          const suspended = raw
            .savepoint(async (c) => {
              await paused
              lateWrite(await refused(() => c`insert into todos (title) values ('suspended')`))
            })
            .then(
              () => 'ran',
              (e: unknown) => String(e),
            )
          const tpl = (s: TemplateStringsArray) => s

          await fdb.endTest()
          resume()

          const outcomes: Record<string, string> = {
            raw: await refused(() => raw`insert into todos (title) values ('raw')`),
            rawUnsafe: await refused(() => raw.unsafe("insert into todos (title) values ('unsafe')")),
            rawSavepoint: await refused(() => raw.savepoint(async () => {})),
            rawBegin: await refused(() => raw.begin(async () => {})),
            child: await refused(() => kept.child`insert into todos (title) values ('child')`),
            grandchild: await refused(() => kept.grandchild`insert into todos (title) values ('grandchild')`),
            viaApply: await refused(() => kept.viaApply`insert into todos (title) values ('viaApply')`),
            bound: await refused(() => kept.bound`insert into todos (title) values ('bound')`),
            boundUnsafe: await refused(() => kept.boundUnsafe("insert into todos (title) values ('boundUnsafe')")),
            destructuredUnsafe: await refused(() =>
              kept.destructuredUnsafe.call(undefined, "insert into todos (title) values ('destructured')"),
            ),
            descriptorUnsafe: await refused(() => kept.descriptorUnsafe("insert into todos (title) values ('descriptor')")),
            descriptorSavepoint: await refused(() => kept.descriptorSavepoint(async () => {})),
            viaCall: await refused(() => kept.child.call(null, tpl`insert into todos (title) values ('call')`)),
            viaApplyCall: await refused(() => kept.child.apply(null, [tpl`insert into todos (title) values ('apply')`])),
            lateWrite: await lateWriteOutcome,
          }
          if (kept.cursor) {
            outcomes.cursor = await refused(async () => {
              for await (const _ of kept.cursor) void _
            })
            outcomes.iterator = await refused(() => kept.iterator.next())
          }
          for (const [form, o] of Object.entries(outcomes)) expect([form, o]).toEqual([form, expect.stringMatching(ENDED)])
          expect(await suspended).not.toBe('ran')
          expect(kept.symbolValues).toEqual([])

          expect(await freshCount(fdb)).toBe(0)
        } finally {
          await fdb.close()
        }
      }, 30_000)
    }
  })
}
