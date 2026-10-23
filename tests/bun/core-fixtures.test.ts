// postgresFixtures() plugs straight into feather-testing-core's fixture
// engine (0.7, vendored as feather-testing-core-next until it is released):
// a test destructures what it needs, and only that is set up.
import { afterAll, describe, expect, test as bunTest } from 'bun:test'
import { coreFixtures, defineTest } from 'feather-testing-core-next/fixtures'
import { count } from 'drizzle-orm'
import { postgresFixtures } from '../../src/fixtures'
import { users } from '../fixtures/schema'
import { MIGRATIONS } from '../contract/runner'

let engineStarts = 0
const test = defineTest({ test: bunTest, afterAll }, coreFixtures()).extend(
  postgresFixtures({ migrations: MIGRATIONS, setup: () => void engineStarts++ }),
)

describe('postgresFixtures() in core’s defineTest', () => {
  test('a test asking for { db } gets the transaction-bound Drizzle handle', async ({ db }) => {
    await db.insert(users).values({ email: 'core@x.test', name: 'Core' })
    const [{ n }] = await db.select({ n: count() }).from(users)
    expect(n).toBe(1)
  })

  test('...rolled back before the next test, which shares sql with db', async ({ db, sql }) => {
    const [{ n }] = await db.select({ n: count() }).from(users)
    expect(n).toBe(0)
    await db.insert(users).values({ email: 'shared@x.test', name: 'S' })
    const rows = await sql<{ email: string }>`select email from users`
    expect(rows.map((r) => r.email)).toEqual(['shared@x.test'])
  })

  test('the engine is file-scoped: started once for the file', async ({ dbEngine }) => {
    expect(dbEngine.strategy).toBe('tx')
    expect(engineStarts).toBe(1)
  })

  test('a test that names no database fixture starts no transaction', async ({ browserName }) => {
    expect(browserName).toBe('chromium')
  })
})
