// beginTest() claims the one test slot before its first await, so two calls
// racing each other cannot both open a test.
import { createFeatherDb, type IsolationStrategy } from '../../src/engine'
import { ENGINE, MIGRATIONS, type RunnerApi } from './runner'

export function oneTestAtATimeContract({ describe, test, expect }: RunnerApi) {
  describe(`one test at a time (${ENGINE})`, () => {
    for (const strategy of ['tx', 'clone'] as IsolationStrategy[])
      test(`concurrent beginTest() calls: one opens, the other is refused (${strategy})`, async () => {
        const fdb = createFeatherDb({ strategy, migrations: MIGRATIONS })
        try {
          const results = await Promise.allSettled([fdb.beginTest(), fdb.beginTest()])
          expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
          const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
          expect(String(refused.reason)).toMatch(/sequentially/)
          // the refused call did not disturb the open test, and the slot frees on endTest
          await fdb.endTest()
          const t = await fdb.beginTest()
          const [{ n }] = await t.sql<{ n: number }>`select count(*)::int as n from users`
          expect(n).toBe(0)
          await fdb.endTest()
        } finally {
          await fdb.close()
        }
      }, 30_000)

    test('a beginTest() that fails to open releases the slot', async () => {
      const fdb = createFeatherDb({ migrations: '/nonexistent/migrations' })
      try {
        await expect(fdb.beginTest()).rejects.toThrow()
        // the second call fails for the same reason, not "sequentially"
        const second = await fdb.beginTest().then(
          () => '',
          (e) => String(e),
        )
        expect(second).not.toMatch(/sequentially/)
      } finally {
        await fdb.close()
      }
    })
  })
}
