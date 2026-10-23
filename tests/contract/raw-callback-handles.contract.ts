// Handles a driver passes INTO raw transaction callbacks (raw.savepoint(child
// => ...), nested) are guarded like raw itself: saved or suspended across
// endTest, writes through them are refused and nothing persists.
import { createFeatherDb, type PostgresDriver } from '../../src/engine'
import { ENGINE, MIGRATIONS, type RunnerApi } from './runner'

export function rawCallbackHandlesContract({ describe, test, expect }: RunnerApi) {
  if (ENGINE !== 'postgres') return
  const drivers: PostgresDriver[] = (globalThis as any).Bun ? ['bun', 'postgres-js'] : ['postgres-js']
  describe('raw callback handles after endTest', () => {
    for (const driver of drivers)
      test(`saved, nested and suspended callback handles are refused (${driver})`, async () => {
        const fdb = createFeatherDb({ driver, migrations: MIGRATIONS, endTestGraceMs: 100 })
        try {
          const t = await fdb.beginTest()
          const raw = t.raw as any
          let saved: any
          let savedNested: any
          await raw.savepoint(async (child: any) => {
            saved = child
            await child.savepoint(async (grandchild: any) => {
              savedNested = grandchild
            })
          })
          let resume!: () => void
          const paused = new Promise<void>((r) => (resume = r))
          let lateWrite!: (outcome: unknown) => void
          const lateWriteOutcome = new Promise<unknown>((r) => (lateWrite = r))
          const suspended = raw
            .savepoint(async (child: any) => {
              await paused // still suspended when the test ends (past the grace)
              // (a refusal may be synchronous: capture it either way)
              await Promise.resolve()
                .then(() => child`insert into todos (title) values ('suspended')`)
                .then(
                () => lateWrite('ran'),
                (e: unknown) => {
                  lateWrite(e)
                  throw e
                },
              )
            })
            .then(
              () => 'ran',
              (e: unknown) => e,
            )
          await fdb.endTest()
          resume()

          // the savepoint itself never reports success (past the grace its
          // connection was retired); the write it attempts is refused
          expect(await suspended).not.toBe('ran')
          const outcomes = await Promise.all([
            lateWriteOutcome,
            Promise.resolve()
              .then(() => saved`insert into todos (title) values ('saved')`)
              .then(() => 'ran', (e: unknown) => e),
            Promise.resolve()
              .then(() => savedNested`insert into todos (title) values ('nested')`)
              .then(() => 'ran', (e: unknown) => e),
            Promise.resolve()
              .then(() => saved.unsafe("insert into todos (title) values ('unsafe')"))
              .then(() => 'ran', (e: unknown) => e),
          ])
          for (const o of outcomes) expect(String(o)).toMatch(/this test has ended/)

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
