// The engines as plain fixture definitions — no runner imported. Any fixture
// engine can drive them (feather-testing-core's runner-agnostic `defineTest`,
// or the standalone `useFixtures` below, which is what `sandboxEach` uses):
//
//   dbEngine  file scope   start() + migrations once per file; close() after
//   testDb    test scope   beginTest() → { db, sql, raw }; endTest() after
//   db        test scope   testDb.db  — the Drizzle handle to inject into the app
//   sql       test scope   testDb.sql — raw SQL on the same transaction
//
// `db` and `sql` share one `testDb`, so they always see the same transaction.

import {
  createFeatherDb,
  type FeatherDb,
  type FeatherDbOptions,
  type SqlRunner,
  type TestDb,
} from './engine'

export type { FeatherDb, FeatherDbOptions, SqlRunner, TestDb } from './engine'

export type FixtureScope = 'test' | 'file'

/** One fixture: set up before the tests that need it, torn down after.
 * `deps` names the fixtures `setup`/`teardown` receive. */
export interface FixtureDef<T, D = Record<string, never>> {
  scope: FixtureScope
  deps?: readonly string[]
  setup(deps: D): T | Promise<T>
  teardown?(value: T, deps: D): void | Promise<void>
}

export interface PostgresFixtures<TDb = any> {
  dbEngine: FixtureDef<FeatherDb<TDb>, {}>
  testDb: FixtureDef<TestDb<TDb>, { dbEngine: FeatherDb<TDb> }>
  db: FixtureDef<TDb, { testDb: TestDb<TDb> }>
  sql: FixtureDef<SqlRunner, { testDb: TestDb<TDb> }>
}

function isFeatherDb(x: unknown): x is FeatherDb {
  return !!x && typeof (x as FeatherDb).beginTest === 'function'
}

/** Fixture definitions for one engine. Pass options (engine/strategy/
 * migrations/...; defaults come from FEATHER_DB and DATABASE_URL) or an
 * existing FeatherDb. The file-scoped `dbEngine` closes it afterwards. */
export function postgresFixtures<TDb = any>(
  options: FeatherDbOptions | FeatherDb<TDb> = {},
): PostgresFixtures<TDb> {
  return {
    dbEngine: {
      scope: 'file',
      async setup() {
        const fdb = isFeatherDb(options) ? options : createFeatherDb<TDb>(options)
        try {
          await fdb.start()
        } catch (e) {
          // A failed migration or setup must not leak the engine (a PGlite
          // instance, a pooled connection, a template database).
          await fdb.close().catch(() => {})
          throw e
        }
        return fdb
      },
      teardown: (fdb) => fdb.close(),
    },
    testDb: {
      scope: 'test',
      deps: ['dbEngine'],
      setup: ({ dbEngine }) => dbEngine.beginTest(),
      teardown: (_t, { dbEngine }) => dbEngine.endTest(),
    },
    db: { scope: 'test', deps: ['testDb'], setup: ({ testDb }) => testDb.db },
    sql: { scope: 'test', deps: ['testDb'], setup: ({ testDb }) => testDb.sql },
  }
}

type AnyDefs<F> = { [K in keyof F]: FixtureDef<any, any> }
type Values<F extends AnyDefs<F>> = { [K in keyof F]: F[K] extends FixtureDef<infer T, any> ? T : never }

export interface LifecycleHooks {
  beforeAll(fn: () => unknown): void
  afterAll(fn: () => unknown): void
  beforeEach(fn: () => unknown): void
  afterEach(fn: () => unknown): void
}

/** A minimal fixture runner on before/after hooks, for runners without a
 * fixture engine. Every fixture is set up (hooks can't see what a test
 * destructures); file-scoped ones once per file, test-scoped ones per test,
 * in dependency order, torn down in reverse. Returns live getters.
 * Tests must run sequentially — never test.concurrent. */
export function useFixtures<F extends AnyDefs<F>>(fixtures: F, hooks: LifecycleHooks): Values<F> {
  const defs = fixtures as unknown as Record<string, FixtureDef<any, any>>
  const order: string[] = []
  const visit = (k: string, path: string[] = []) => {
    if (order.includes(k)) return
    if (path.includes(k)) throw new Error(`fixture cycle: ${[...path, k].join(' → ')}`)
    if (!defs[k]) throw new Error(`unknown fixture '${k}'`)
    for (const d of defs[k].deps ?? []) visit(d, [...path, k])
    order.push(k)
  }
  for (const k of Object.keys(defs)) visit(k)

  const values: Record<string, unknown> = {}
  const live = new Set<string>()
  const depsOf = (k: string) => Object.fromEntries((defs[k].deps ?? []).map((d) => [d, values[d]]))

  const setupScope = async (scope: FixtureScope) => {
    for (const k of order)
      if (defs[k].scope === scope) {
        values[k] = await defs[k].setup(depsOf(k))
        live.add(k)
      }
  }
  const teardownScope = async (scope: FixtureScope) => {
    let first: unknown
    for (const k of [...order].reverse())
      if (defs[k].scope === scope && live.has(k)) {
        live.delete(k)
        try {
          await defs[k].teardown?.(values[k], depsOf(k))
        } catch (e) {
          first ??= e
        }
        delete values[k]
      }
    if (first) throw first
  }

  hooks.beforeAll(() => setupScope('file'))
  hooks.afterAll(() => teardownScope('file'))
  hooks.beforeEach(() => setupScope('test'))
  hooks.afterEach(() => teardownScope('test'))

  const out = {} as Values<F>
  for (const k of Object.keys(defs))
    Object.defineProperty(out, k, {
      enumerable: true,
      get() {
        if (!live.has(k))
          throw new Error(
            `fixture '${k}' is not available here (${defs[k].scope}-scoped: read it inside a test${defs[k].scope === 'file' ? ' or hook' : ''})`,
          )
        return values[k]
      },
    })
  return out
}
