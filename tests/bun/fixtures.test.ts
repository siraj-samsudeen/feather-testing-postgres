// The runner-facing layer under bun:test: plain fixture definitions, and the
// standalone sandboxEach() helper that drives them with bun:test hooks.
import { describe, expect, test } from 'bun:test'
import { count } from 'drizzle-orm'
import { postgresFixtures, type FeatherDb, type TestDb } from '../../src/fixtures'
import { sandboxEach, useBunFixtures } from '../../src/bun'
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

describe('postgresFixtures(): definitions in the Playwright/core fixture shape', () => {
  const defs = postgresFixtures({ migrations: MIGRATIONS })

  test('declares scopes and dependencies', () => {
    expect(defs.dbEngine[1]).toMatchObject({ scope: 'file', deps: [] })
    expect(defs.testDb[1]).toMatchObject({ scope: 'test', deps: ['dbEngine'] })
    expect(defs.db[1]).toMatchObject({ scope: 'test', deps: ['testDb'] })
    expect(defs.sql[1]).toMatchObject({ scope: 'test', deps: ['testDb'] })
  })

  test('driven by hand through use(), as any fixture engine would', async () => {
    const rounds: number[] = []
    await defs.dbEngine[0]({}, async (dbEngine: FeatherDb) => {
      for (const round of [1, 2])
        await defs.testDb[0]({ dbEngine }, async (testDb: TestDb) => {
          await defs.sql[0]({ testDb }, async (sql) => {
            const [{ n }] = await sql<{ n: number }>`select count(*)::int as n from users`
            rounds.push(n) // round 2 sees nothing from round 1
          })
          await defs.db[0]({ testDb }, async (db) => {
            await db.insert(users).values({ email: `r${round}@x.test`, name: 'R' })
          })
        })
    })
    expect(rounds).toEqual([0, 0])
  })
})

describe('useFixtures(): plain values, { value: true } functions, destructured deps', () => {
  const greet = (n: string) => `hi ${n}`
  const t = useBunFixtures({
    name: 'Ada',
    greet: [greet, { value: true }] as const,
    greeting: async ({ name, greet }: { name: string; greet: (n: string) => string }, use: (v: string) => Promise<void>) =>
      use(greet(name)),
  })
  test('resolves them in dependency order', () => {
    expect(t.greeting).toBe('hi Ada')
    expect(t.greet).toBe(greet)
  })
})
