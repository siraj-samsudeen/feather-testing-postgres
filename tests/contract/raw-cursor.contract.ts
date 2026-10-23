// postgres.js query objects can hand out new executable objects — cursors
// (async iterators) and forEach queries. Built before endTest and consumed
// after, they must be refused and write nothing.
import { createFeatherDb } from '../../src/engine'
import { ENGINE, MIGRATIONS, type RunnerApi } from './runner'

export function rawCursorContract({ describe, test, expect }: RunnerApi) {
  if (ENGINE !== 'postgres') return
  describe('postgres.js raw cursors and forEach after endTest', () => {
    test('built before the end, consumed after: refused, nothing written', async () => {
      const fdb = createFeatherDb({ driver: 'postgres-js', migrations: MIGRATIONS })
      try {
        const t = await fdb.beginTest()
        const raw = t.raw as any
        const cursor = raw`insert into todos (title) values ('via cursor') returning id`.cursor()
        const iterator = raw`insert into todos (title) values ('via iterator') returning id`.cursor()[Symbol.asyncIterator]()
        const each = raw`insert into todos (title) values ('via forEach') returning id`.forEach(() => {})
        await fdb.endTest()

        const outcomes = await Promise.all([
          (async () => {
            for await (const _rows of cursor) void _rows
          })().then(() => 'ran', (e: unknown) => e),
          Promise.resolve().then(() => iterator.next()).then(() => 'ran', (e: unknown) => e),
          Promise.resolve().then(() => each).then(() => 'ran', (e: unknown) => e),
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
