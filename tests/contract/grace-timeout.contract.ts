// An app transaction still suspended when endTest's grace runs out must never
// touch the next test: its later savepoint cleanup would otherwise run on a
// connection the next test reuses.
import { todos } from '../fixtures/schema'
import { createFeatherDb } from '../../src/engine'
import { ENGINE, MIGRATIONS, type RunnerApi } from './runner'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function graceTimeoutContract({ describe, test, expect }: RunnerApi) {
  describe(`endTest grace runs out (${ENGINE})`, () => {
    for (const fails of [true, false])
      test(`a suspended transaction that later ${fails ? 'fails' : 'succeeds'} cannot touch the next test`, async () => {
        const fdb = createFeatherDb({ migrations: MIGRATIONS, endTestGraceMs: 50 })
        try {
          const t1 = await fdb.beginTest()
          let wrote!: () => void
          const written = new Promise<void>((r) => (wrote = r))
          let resume!: () => void
          const suspended = new Promise<void>((r) => (resume = r))
          const late = t1.db
            .transaction(async (tx: any) => {
              await tx.insert(todos).values({ title: 'suspended' })
              wrote()
              await suspended // still suspended when the grace runs out
              if (fails) throw new Error('late failure')
            })
            .then(
              () => 'resolved',
              (e: unknown) => e,
            )
          await written
          await fdb.endTest()

          const t2 = await fdb.beginTest()
          await t2.db.insert(todos).values({ title: 'next test' })
          resume() // its savepoint cleanup now runs — somewhere
          await late
          await sleep(30)
          // the next test's transaction is intact and sees only its own row
          const rows = await t2.sql<{ title: string }>`select title from todos`
          expect(rows.map((r) => r.title)).toEqual(['next test'])
          await fdb.endTest()
        } finally {
          await fdb.close()
        }
      }, 30_000)
  })
}
