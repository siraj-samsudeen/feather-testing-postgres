// The runner-facing layer under bun:test: plain fixture definitions, and the
// standalone sandboxEach() helper that drives them with bun:test hooks.
import { describe, expect, test } from 'bun:test'
import { count } from 'drizzle-orm'
import { postgresFixtures, useFixtures, type FeatherDb, type TestDb } from '../../src/fixtures'
import { sandboxEach, useBunFixtures, type FixtureValues } from '../../src/bun'
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

describe('useFixtures(): a { value: true } function keeps its type', () => {
  const sent: string[] = []
  // shaped like a fixture function (returns Promise<void>), but marked a value
  const sendJob = async (job: string) => {
    sent.push(job)
  }
  const t = useBunFixtures({ sendJob: [sendJob, { value: true }] as const })
  test('typed as the function itself, not as a fixture function', async () => {
    const typed: (job: string) => Promise<void> = t.sendJob
    // @ts-expect-error — not unknown/any: a wrong type is rejected
    const wrong: (job: number) => string = t.sendJob
    void wrong
    await typed('email')
    expect(sent).toEqual(['email'])
  })
})

describe('useFixtures(): a two-element array value is a value, not [fixture, options]', () => {
  const setups: string[] = []
  const t = useBunFixtures({
    rows: [{ id: 1 }, { id: 2 }],
    pair: [1, {}],
    unknownKey: ['x', { scope: 'file', colour: 'red' }],
    // still a real pair: options with known keys only
    perFile: [
      async ({}, use: (v: string) => Promise<void>) => {
        setups.push('perFile')
        await use('shared')
      },
      { scope: 'file' },
    ] as const,
    plainPair: [{ id: 3 }, { scope: 'file' }] as const,
  })
  test('arrays come through whole', () => {
    expect(t.rows).toEqual([{ id: 1 }, { id: 2 }])
    expect(t.pair).toEqual([1, {}])
    expect(t.unknownKey).toEqual(['x', { scope: 'file', colour: 'red' }])
  })
  test('[fn, { scope }] and [value, { scope }] are still pairs', () => {
    expect(t.perFile).toBe('shared')
    expect(t.plainPair).toEqual({ id: 3 })
    expect(setups).toEqual(['perFile']) // file scope: set up once
  })
})

// types follow the same rule (type-checked only, never run)
const typesFollowTheSameRule = (t: FixtureValues<{
  pair: readonly [1, {}]
  odd: readonly ['x', { readonly colour: 'red' }]
  real: readonly [{ readonly id: 3 }, { readonly scope: 'file' }]
}>) => {
  const typed = t
  type Check = [typeof t.pair, typeof t.odd, typeof t.real]
  const ok: Check = [[1, {}], ['x', { colour: 'red' }], { id: 3 }]
  // @ts-expect-error — [1, {}] is the value, not 1
  const wrong: number = t.pair
  void ok
  void wrong
  void typed
}
void typesFollowTheSameRule

describe('useFixtures(): a failed start surfaces the real error', () => {
  test('getters rethrow the start error, not "not available here"', async () => {
    const registered: Record<string, Array<() => unknown>> = { beforeAll: [], afterAll: [], beforeEach: [], afterEach: [] }
    const hooks = {
      beforeAll: (f: () => unknown) => void registered.beforeAll.push(f),
      afterAll: (f: () => unknown) => void registered.afterAll.push(f),
      beforeEach: (f: () => unknown) => void registered.beforeEach.push(f),
      afterEach: (f: () => unknown) => void registered.afterEach.push(f),
    }
    const t = useFixtures(postgresFixtures({ migrations: '/nonexistent/migrations' }), hooks)
    const run = (f: () => unknown) => Promise.resolve().then(f).then(() => null, (e: unknown) => e as Error)

    const startError = await run(registered.beforeAll[0])
    expect(startError).toBeInstanceOf(Error)
    await run(registered.beforeEach[0]) // a test after the failed start
    for (const read of [() => t.dbEngine, () => t.testDb, () => t.db, () => t.sql]) {
      let message = ''
      try {
        read()
      } catch (e) {
        message = String(e)
      }
      expect(message).toContain(startError!.message)
      expect(message).not.toMatch(/not available here/)
    }
    await run(registered.afterEach[0])
    await run(registered.afterAll[0])
  })
})
