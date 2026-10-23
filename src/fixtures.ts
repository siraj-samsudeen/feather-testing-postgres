// The engines as fixture definitions in the Playwright Test shape that
// feather-testing-core's fixture engine (`feather-testing-core/fixtures`,
// 0.7+) takes — so they plug straight in, with core an optional peer:
//
//   const test = defineTest({ test, afterAll }, coreFixtures()).extend(postgresFixtures())
//   test('lists todos', async ({ db }) => { ... })   // only what is named is set up
//
//   dbEngine  file scope   start() + migrations once per file; close() after
//   testDb    test scope   beginTest() → { db, sql, raw }; endTest() after
//   db        test scope   testDb.db  — the Drizzle handle to inject into the app
//   sql       test scope   testDb.sql — raw SQL on the same transaction
//
// `db` and `sql` share one `testDb`, so they always see the same transaction.
// Without core, `useFixtures` below (and `sandboxEach` in /bun) drives the
// same definitions on before/after hooks.

import {
  createFeatherDb,
  type FeatherDb,
  type FeatherDbOptions,
  type SqlRunner,
  type TestDb,
} from './engine'

export type { FeatherDb, FeatherDbOptions, SqlRunner, TestDb } from './engine'

/** Hand the fixture's value to the test; resolves once the test is done. */
export type Use<T> = (value: T) => Promise<void>
/** Set up, `use` the value, then tear down. */
export type FixtureFn<T, D = any> = (deps: D, use: Use<T>, info?: unknown) => Promise<void>
export type FixtureScope = 'test' | 'file' | 'worker'
export interface FixtureOptions {
  /** 'test' (default) or 'file' (alias 'worker'): once per file. */
  scope?: FixtureScope
  /** Dependencies, when they can't be read from the first parameter. */
  deps?: string[]
  /** Treat a function as the fixture's value, not as a fixture function. */
  value?: boolean
}
/** A plain value, a fixture function, or either with options — core's shape. */
export type FixtureDef<T, D = any> = T | FixtureFn<T, D> | [T | FixtureFn<T, D>, FixtureOptions]

export interface PostgresFixtureValues<TDb = any> {
  dbEngine: FeatherDb<TDb>
  testDb: TestDb<TDb>
  db: TDb
  sql: SqlRunner
}

export interface PostgresFixtures<TDb = any> {
  dbEngine: [FixtureFn<FeatherDb<TDb>, {}>, FixtureOptions]
  testDb: [FixtureFn<TestDb<TDb>, { dbEngine: FeatherDb<TDb> }>, FixtureOptions]
  db: [FixtureFn<TDb, { testDb: TestDb<TDb> }>, FixtureOptions]
  sql: [FixtureFn<SqlRunner, { testDb: TestDb<TDb> }>, FixtureOptions]
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
    dbEngine: [
      // eslint-disable-next-line no-empty-pattern
      async ({}, use) => {
        const fdb = isFeatherDb(options) ? options : createFeatherDb<TDb>(options)
        try {
          await fdb.start()
        } catch (e) {
          // A failed migration or setup must not leak the engine (a PGlite
          // instance, a pooled connection, a template database).
          await fdb.close().catch(() => {})
          throw e
        }
        try {
          await use(fdb)
        } finally {
          await fdb.close()
        }
      },
      { scope: 'file', deps: [] },
    ],
    testDb: [
      async ({ dbEngine }, use) => {
        const t = await dbEngine.beginTest()
        try {
          await use(t)
        } finally {
          await dbEngine.endTest()
        }
      },
      { scope: 'test', deps: ['dbEngine'] },
    ],
    db: [
      async ({ testDb }, use) => {
        await use(testDb.db)
      },
      { scope: 'test', deps: ['testDb'] },
    ],
    sql: [
      async ({ testDb }, use) => {
        await use(testDb.sql)
      },
      { scope: 'test', deps: ['testDb'] },
    ],
  }
}

// ---------------------------------------------------------------------------
// A minimal runner for the same definitions, for runners without a fixture
// engine (no dependency on feather-testing-core).

export interface LifecycleHooks {
  beforeAll(fn: () => unknown): void
  afterAll(fn: () => unknown): void
  beforeEach(fn: () => unknown): void
  afterEach(fn: () => unknown): void
}

// (readonly too, so `[fn, { value: true }] as const` keeps its types)
/** An options object: at least one key, and only known option keys. */
type IsOptions<O> = O extends FixtureOptions
  ? [keyof O] extends [never]
    ? false
    : [Exclude<keyof O, keyof FixtureOptions>] extends [never]
      ? true
      : false
  : false

type ValueOf<D> = D extends readonly [infer X, infer O]
  ? IsOptions<O> extends false
    ? D // a two-element array value, not [fixture, options]
    : O extends { value: true }
    ? X // marked a value: the function itself, even if it looks like a fixture
    : X extends FixtureFn<infer T, any>
      ? T
      : X
  : D extends FixtureFn<infer T, any>
    ? T
    : D
export type FixtureValues<F> = { [K in keyof F]: ValueOf<F[K]> }

/** The names a function's first parameter destructures: `({ a, b: x }) =>`. */
function destructured(fn: Function): string[] {
  const m = /^[^(]*\(\s*\{([^}]*)\}/.exec(fn.toString())
  if (!m) return []
  return m[1]
    .split(',')
    .map((p) => p.split(/[:=]/)[0].trim())
    .filter((p) => p && !p.startsWith('...'))
}

interface Normal {
  fn: FixtureFn<unknown> | null
  value: unknown
  scope: 'test' | 'file'
  deps: string[]
}

const OPTION_KEYS = new Set(['scope', 'deps', 'value'])

/** [fixture, options] only when the second element is a plain object with at
 * least one key, all of them option keys — otherwise a two-element array (rows,
 * a pair of values) is itself the fixture's value. */
function isOptions(x: unknown): x is FixtureOptions {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false
  const proto = Object.getPrototypeOf(x)
  if (proto !== Object.prototype && proto !== null) return false
  const keys = Object.keys(x)
  return keys.length > 0 && keys.every((k) => OPTION_KEYS.has(k))
}

function normalise(def: unknown): Normal {
  const [v, o] =
    Array.isArray(def) && def.length === 2 && isOptions(def[1])
      ? (def as [unknown, FixtureOptions])
      : [def, {} as FixtureOptions]
  const isFn = typeof v === 'function' && !o.value
  return {
    fn: isFn ? (v as FixtureFn<unknown>) : null,
    value: v,
    scope: o.scope === 'file' || o.scope === 'worker' ? 'file' : 'test',
    deps: o.deps ?? (isFn ? destructured(v as Function) : []),
  }
}

/** Runs fixture definitions on before/after hooks. Every fixture is set up
 * (hooks can't see what a test destructures): file-scoped once per file,
 * test-scoped per test, in dependency order, torn down in reverse. Returns
 * live getters. Tests must run sequentially — never test.concurrent. */
export function useFixtures<F extends object>(fixtures: F, hooks: LifecycleHooks): FixtureValues<F> {
  const defs = Object.fromEntries(Object.entries(fixtures).map(([k, d]) => [k, normalise(d)]))
  const order: string[] = []
  const visit = (k: string, path: string[] = []) => {
    if (order.includes(k)) return
    if (path.includes(k)) throw new Error(`fixture cycle: ${[...path, k].join(' → ')}`)
    if (!defs[k]) throw new Error(`unknown fixture '${k}'${path.length ? ` (needed by '${path.at(-1)}')` : ''}`)
    for (const d of defs[k].deps) visit(d, [...path, k])
    order.push(k)
  }
  for (const k of Object.keys(defs)) visit(k)

  const values: Record<string, unknown> = {}
  const finishers = new Map<string, () => Promise<void>>()
  // why a fixture isn't available: its own setup failed, or a dependency's
  const failures = new Map<string, unknown>()

  async function setUp(k: string) {
    const d = defs[k]
    if (!d.fn) {
      values[k] = d.value
      finishers.set(k, async () => {})
      return
    }
    const deps = Object.fromEntries(d.deps.map((n) => [n, values[n]]))
    let release!: () => void
    const released = new Promise<void>((r) => (release = r))
    let handOver!: (v: unknown) => void
    const handed = new Promise<unknown>((r) => (handOver = r))
    const done = d.fn(
      deps,
      async (v) => {
        handOver(v)
        await released
      },
      { title: '', status: 'running' },
    )
    values[k] = await Promise.race([
      handed,
      done.then(() => {
        throw new Error(`fixture '${k}' finished without calling use()`)
      }),
    ])
    finishers.set(k, async () => {
      release()
      await done
    })
  }

  const setupScope = async (scope: 'test' | 'file') => {
    let first: unknown
    for (const k of order) {
      if (defs[k].scope !== scope) continue
      const failedDep = defs[k].deps.find((d) => failures.has(d))
      if (failedDep !== undefined) {
        failures.set(k, failures.get(failedDep))
        first ??= failures.get(failedDep)
        continue
      }
      try {
        await setUp(k)
      } catch (e) {
        failures.set(k, e)
        first ??= e
      }
    }
    if (first !== undefined) throw first
  }
  const teardownScope = async (scope: 'test' | 'file') => {
    for (const k of order) if (defs[k].scope === scope) failures.delete(k)
    let first: unknown
    for (const k of [...order].reverse())
      if (defs[k].scope === scope && finishers.has(k)) {
        const finish = finishers.get(k)!
        finishers.delete(k)
        try {
          await finish()
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

  const out = {} as FixtureValues<F>
  for (const k of Object.keys(defs))
    Object.defineProperty(out, k, {
      enumerable: true,
      get() {
        // a failed setup: its real error, not "not available here"
        if (failures.has(k)) throw failures.get(k)
        if (!finishers.has(k))
          throw new Error(
            `fixture '${k}' is not available here (${defs[k].scope}-scoped: read it inside a test${defs[k].scope === 'file' ? ' or hook' : ''})`,
          )
        return values[k]
      },
    })
  return out
}
