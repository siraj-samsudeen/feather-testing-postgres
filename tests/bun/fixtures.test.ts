// The runner-facing layer under bun:test: plain fixture definitions, and the
// standalone sandboxEach() helper that drives them with bun:test hooks.
import { describe, expect, test } from 'bun:test'
import { count } from 'drizzle-orm'
import { postgresFixtures, type FeatherDb, type TestDb } from '../../src/fixtures'
import { sandboxEach } from '../../src/bun'
import { users } from '../fixtures/schema'
import { MIGRATIONS } from '../contract/runner'

describe('sandboxEach()', () => {
  const t = sandboxEach({ migrations: MIGRATIONS })

  test('hands each test a db bound to its transaction', async () => {
    await t.db.insert(users).values({ email: 'a@x.test', name: 'A' })
    const [{ n }] = await t.sql<{ n: number }>`select count(*)::int as n from users`
    expect(n).toBe(1)
  })

  test('...rolled back before the next test', async () => {
    const [{ n }] = await t.db.select({ n: count() }).from(users)
    expect(n).toBe(0)
  })

  test('exposes the engine', () => {
    expect(t.dbEngine.strategy).toBe('tx')
  })
})

describe('postgresFixtures(): definitions a fixture engine can drive', () => {
  const defs = postgresFixtures({ migrations: MIGRATIONS })

  test('declares scopes and dependencies', () => {
    expect(defs.dbEngine.scope).toBe('file')
    expect(defs.testDb).toMatchObject({ scope: 'test', deps: ['dbEngine'] })
    expect(defs.db).toMatchObject({ scope: 'test', deps: ['testDb'] })
    expect(defs.sql).toMatchObject({ scope: 'test', deps: ['testDb'] })
  })

  test('set up and torn down by hand, as an engine would', async () => {
    const dbEngine = (await defs.dbEngine.setup({})) as FeatherDb
    try {
      for (const round of [1, 2]) {
        const testDb = (await defs.testDb.setup({ dbEngine })) as TestDb
        const db = await defs.db.setup({ testDb })
        const sql = await defs.sql.setup({ testDb })
        const [{ n }] = await sql<{ n: number }>`select count(*)::int as n from users`
        expect(n).toBe(0) // round 2 sees nothing from round 1
        await db.insert(users).values({ email: `r${round}@x.test`, name: 'R' })
        await defs.testDb.teardown!(testDb, { dbEngine })
      }
    } finally {
      await defs.dbEngine.teardown!(dbEngine, {})
    }
  })
})
