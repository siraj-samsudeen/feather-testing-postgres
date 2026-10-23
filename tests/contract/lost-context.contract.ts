// Under tx, a query issued outside an open transaction waits for it — and if
// it was meant to run inside it but lost the async context (a worker or queue
// started elsewhere), that wait would never end. Past endTestGraceMs it fails
// with a clear error instead of deadlocking silently.
import { createFeatherDb } from '../../src/engine'
import { todos } from '../fixtures/schema'
import { ENGINE, MIGRATIONS, type RunnerApi } from './runner'
import { refused } from './reflection'

export function lostContextContract({ describe, test, expect }: RunnerApi) {
  describe(`lost async context (${ENGINE})`, () => {
    for (const via of ['db', 'sql', 'raw', 'db.transaction'] as const)
      test(`a root-level ${via} call from a lost context fails clearly instead of deadlocking`, async () => {
        const fdb = createFeatherDb({ migrations: MIGRATIONS, endTestGraceMs: 200 })
        try {
          const t = await fdb.beginTest()
          // a worker started outside the transaction: its jobs run in the root
          // async context, not the transaction's
          const jobs: Array<() => Promise<void>> = []
          let wake!: () => void
          const worker = (async () => {
            for (;;) {
              await new Promise<void>((r) => (wake = r))
              const job = jobs.shift()
              if (!job) return
              await job()
            }
          })()
          const call = {
            db: () => t.db.select().from(todos),
            sql: () => t.sql`select 1`,
            raw: () => t.raw`select 1`,
            'db.transaction': () => t.db.transaction(async () => {}),
          }[via]
          const outcome = await t.db.transaction(async (tx: any) => {
            await tx.insert(todos).values({ title: 'inside' })
            const result = new Promise<string>((r) => jobs.push(async () => r(await refused(call))))
            wake()
            return result // the transaction waits for the job; the job for the transaction
          })
          expect(outcome).toMatch(/async context lost\?/)
          // the queue still follows the transaction that was open: nothing
          // was let through early
          expect((await t.db.select().from(todos)).map((r: any) => r.title)).toEqual(['inside'])
          wake() // no job left: the worker stops
          await worker
          await fdb.endTest()
        } finally {
          await fdb.close()
        }
      }, 10_000)
  })
}
