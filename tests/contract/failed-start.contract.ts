// A start() that fails (bad migrations, a throwing setup) must not leak the
// engine: the dbEngine fixture closes it before rethrowing.
import { createFeatherDb, type FeatherDbOptions, type IsolationStrategy } from '../../src/engine'
import { postgresFixtures } from '../../src/fixtures'
import { ENGINE, MIGRATIONS, type RunnerApi } from './runner'

const failures: Array<[string, FeatherDbOptions, RegExp]> = [
  ['a failed migration', { migrations: '/nonexistent/migrations' }, /./],
  ['a failed setup', { migrations: MIGRATIONS, setup: () => { throw new Error('setup exploded') } }, /setup exploded/],
]

async function leftoverTemplates(): Promise<number> {
  if (ENGINE !== 'postgres') return 0
  const probe = createFeatherDb({})
  try {
    const t = await probe.beginTest()
    const [{ n }] = await t.sql<{ n: number }>`
      select count(*)::int as n from pg_database where datname ~ ${`^feather_tpl_[0-9a-f]{8}_${process.pid}_`}`
    return n
  } finally {
    await probe.close()
  }
}

export function failedStartContract({ describe, test, expect }: RunnerApi) {
  describe(`a failed start is cleaned up (${ENGINE})`, () => {
    for (const strategy of ['tx', 'clone'] as IsolationStrategy[])
      for (const [what, options, error] of failures)
        test(`${what} (${strategy}): the fixture closes the engine and rethrows`, async () => {
          const fdb = createFeatherDb({ strategy, ...options })
          let closed = 0
          const close = fdb.close
          ;(fdb as { close: () => Promise<void> }).close = async () => {
            closed++
            await close()
          }
          await expect(postgresFixtures(fdb).dbEngine[0]({}, async () => {})).rejects.toThrow(error)
          expect(closed).toBe(1)
          expect(await leftoverTemplates()).toBe(0)
        }, 30_000)
  })
}
