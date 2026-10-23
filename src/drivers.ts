// Driver adapters: Bun.sql, postgres.js and PGlite behind one small interface,
// and the clients drizzle runs a test's queries on.

import { Scheduler, clientHiddenError, endHeld, endedError, type QueryGate } from './scheduler'
import { pglitePort, rawFacade, taggedPort, templateToText, type RawSql } from './raw'
import type { PostgresDriver, SqlRunner } from './engine'

export interface Conn {
  /** Called on each new pool (drizzle's postgres-js parsers live on it). */
  prepare?: (client: unknown) => void
  /** Replace the pool and start closing the old one (Postgres only); the
   * returned promise settles when the old pool is closed. */
  retire?: () => { closed: Promise<void> }
  sql: SqlRunner
  /** Runs fn in a transaction that the caller controls through `release`. */
  hold(graceMs: number): Promise<{ tx: RawSql; client: unknown; sql: SqlRunner; sched: Scheduler; release(): Promise<void> }>
  /** The client drizzle should be built over when no test transaction is held. */
  client: unknown
  kind: 'bun' | 'postgres-js' | 'pglite'
  /** timeoutSeconds 0 force-closes (Postgres pools). */
  close(timeoutSeconds?: number): Promise<void>
}

export class Rollback extends Error {
  constructor() {
    super('feather-testing-postgres: test rollback (this should never surface)')
  }
}

/** Opens a callback-style transaction and keeps it open until release(). The
 * thrown sentinel makes every driver ROLLBACK, on pass and fail alike. */
export async function holdOpen(
  begin: (fn: (tx: any) => Promise<void>) => Promise<unknown>,
): Promise<{ tx: any; release(): Promise<void> }> {
  let gotTx!: (tx: any) => void
  let release!: () => void
  const txReady = new Promise<any>((res) => (gotTx = res))
  const released = new Promise<void>((res) => (release = res))
  const done = begin(async (tx) => {
    gotTx(tx)
    await released
    throw new Rollback()
  }).then(
    () => {},
    (e) => {
      if (!(e instanceof Rollback)) throw e
    },
  )
  const tx = await Promise.race([txReady, done.then(() => Promise.reject(new Error('transaction ended early')))])
  return {
    tx,
    async release() {
      release()
      await done
    },
  }
}

/** Bun.sql and postgres.js: a tagged-template client. */
export function taggedSql(client: any, gate?: QueryGate): SqlRunner {
  const q = <T>(fn: () => T | PromiseLike<T>) => (gate ? gate.query(fn) : Promise.resolve().then(fn))
  const run = (async (strings: TemplateStringsArray, ...values: unknown[]) =>
    Array.from(await q(() => client(strings, ...values)))) as SqlRunner
  run.unsafe = async (text, params) => Array.from(await q(() => client.unsafe(text, params ?? [])))
  return run
}

/** PGlite: query(text, params). */
export function pgliteSql(client: any, gate?: QueryGate): SqlRunner {
  const q = <T>(fn: () => T | PromiseLike<T>) => (gate ? gate.query(fn) : Promise.resolve().then(fn))
  const run = (async (strings: TemplateStringsArray, ...values: unknown[]) =>
    (await q(() => client.query(templateToText(strings, values), values))).rows) as SqlRunner
  run.unsafe = async (text, params) => (await q(() => client.query(text, params ?? []))).rows
  return run
}

/** A clone's drizzle db (and its transactions) with $client hidden, as under
 * tx. Drizzle never reads $client itself — it runs on its own session. */
export function hideClient(db: any): any {
  if (Object.prototype.hasOwnProperty.call(db, '$client')) delete db.$client
  return new Proxy(db, {
    get(target, prop) {
      if (prop === '$client') throw clientHiddenError()
      if (prop === 'transaction')
        return (fn: (tx: unknown) => unknown, config?: unknown) =>
          target.transaction((tx: any) => fn(hideClient(tx)), config)
      const v = Reflect.get(target, prop)
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
}

/** The client drizzle runs a test's queries on (Bun.sql / postgres.js): an
 * adapter object of our own — like raw, never a proxy over the driver, so
 * nothing reachable from drizzle's session is a driver object (db.$client
 * itself is hidden). It offers only what
 * drizzle's bun-sql and postgres-js sessions use: unsafe(q, p, opts) (awaited
 * or .values()), begin/savepoint (a SAVEPOINT, so db.transaction() nests; the
 * callback gets another adapter), and options (drizzle writes its parsers
 * there at construction; a throwaway — the real parsers live on the root
 * pool, configured when the engine starts). */
export function taggedClient(root: any, gate: QueryGate, pool: boolean): unknown {
  const adapt = (handle: any, isPool: boolean): unknown => {
    const begin = (a: unknown, b?: unknown) => {
      gate.check()
      const fn = (typeof a === 'function' ? a : b) as (c: unknown) => unknown
      // a pool opens a real transaction (clone); a transaction handle a
      // SAVEPOINT (tx, and nested transactions everywhere)
      const work = isPool
        ? handle.begin((h: any) => fn(adapt(h, false)))
        : handle.savepoint((h: any) => fn(adapt(h, false)))
      if (isPool) gate.track(work)
      return work
    }
    return Object.freeze({
      get options() {
        return { parsers: {}, serializers: {} }
      },
      unsafe: (query: string, params?: unknown[], opts?: unknown) => {
        const exec = <R>(f: (q: any) => R) =>
          gate.query(() => f(opts === undefined ? handle.unsafe(query, params) : handle.unsafe(query, params, opts)))
        return Object.freeze({
          values: () => exec((q) => q.values()),
          then: (ok?: (v: any) => unknown, ko?: (e: unknown) => unknown) => exec((q) => q).then(ok, ko),
        })
      },
      begin,
      savepoint: (a: unknown, b?: unknown) => {
        gate.check()
        const fn = (typeof a === 'function' ? a : b) as (c: unknown) => unknown
        return handle.savepoint((h: any) => fn(adapt(h, false)))
      },
    })
  }
  return adapt(root, pool)
}

/** A clone's PGlite instance as drizzle's client: queries through the clone's
 * gate; db.transaction() is a real PGlite transaction (nested ones are
 * SAVEPOINTs drizzle issues through query). */
export function pgliteInstanceClient(pg: any, gate: QueryGate): unknown {
  const inTx = (tx: any) =>
    Object.freeze({
      query: (...a: unknown[]) => gate.query(() => tx.query(...a)),
      exec: (...a: unknown[]) => gate.query(() => tx.exec(...a)),
    })
  return Object.freeze({
    query: (...a: unknown[]) => gate.query(() => pg.query(...a)),
    exec: (...a: unknown[]) => gate.query(() => pg.exec(...a)),
    transaction: (fn: (c: unknown) => unknown) => {
      gate.check()
      const work = pg.transaction((tx: any) => fn(inTx(tx)))
      gate.track(work)
      return work
    },
  })
}

/** A PGlite transaction whose `transaction()` opens a SAVEPOINT (drizzle's
 * pglite session calls client.transaction for db.transaction()). */
export function savepointingPgliteTx(tx: any, sched: Scheduler): unknown {
  let n = 0
  const client: any = Object.freeze({
    query: (...a: unknown[]) => sched.query(() => tx.query(...a)),
    exec: (...a: unknown[]) => sched.query(() => tx.exec(...a)),
    async transaction(fn: (c: unknown) => Promise<unknown>) {
      sched.check() // no new savepoint once the test has ended
      // the savepoint machinery may roll back while endTest drains in-flight
      // work, but never touches the connection once the test transaction is gone
      // async: a refusal is a rejection, so the .catch below sees it
      const machinery = async (q: string) => {
        if (sched.closed) throw sched.endedError()
        return tx.query(q)
      }
      const name = `feather_sp_${++n}`
      await machinery(`savepoint ${name}`)
      try {
        const result = await fn(client)
        await machinery(`release savepoint ${name}`)
        return result
      } catch (e) {
        // the original failure wins over a failed rollback
        await machinery(`rollback to savepoint ${name}`).catch(() => {})
        throw e
      }
    },
  })
  return client
}

/** Loads an optional peer. The specifier is not a literal, so TypeScript does
 * not resolve it: a consumer without that peer installed still type-checks
 * this source (it ships as .ts). */
export const optionalPeer = (name: string): Promise<any> => import(/* @vite-ignore */ name)

/** The search_path the library's own SQL runs under: nothing a user schema
 * defines (a function, an operator) can stand in for a built-in. */
export const PINNED_SEARCH_PATH = 'pg_catalog, pg_temp'

/** The database a URL names in its path (the URL is required to name one). */
function pathDatabase(url: string): string {
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''))
  if (!name) throw new Error('feather-testing-postgres: the database URL must name its database, e.g. postgres://…/app_test')
  return name
}

/** URL parameters a library-only connection keeps: transport only. Anything
 * else (search_path, options, any GUC) could change how SQL resolves. */
const TRANSPORT_PARAMS = new Set([
  'ssl',
  'sslmode',
  'sslrootcert',
  'sslcert',
  'sslkey',
  'sslpassword',
  'sslnegotiation',
  'connect_timeout',
  'target_session_attrs',
])

/** The URL for a library-only connection: the same server, credentials and
 * database, with every parameter that isn't transport removed. */
export function libraryUrl(url: string): string {
  const u = new URL(url)
  for (const key of [...u.searchParams.keys()]) if (!TRANSPORT_PARAMS.has(key.toLowerCase())) u.searchParams.delete(key)
  return u.toString()
}

/** `library`: a connection only the library uses (admin, cleanup, the guard).
 * It takes nothing from the URL that changes how SQL resolves (libraryUrl),
 * starts every session with search_path = PINNED_SEARCH_PATH, and runs no
 * driver startup query (postgres.js: fetch_types off; Bun.sql runs none).
 * Test connections use the URL as given. Either way the path's database is
 * handed to the driver explicitly (Bun.sql would otherwise let PGDATABASE
 * override it). */
export async function connectPostgres(
  url: string,
  driver: PostgresDriver,
  max = 2,
  opts: { library?: boolean } = {},
): Promise<Conn> {
  let make: () => any
  const target = opts.library ? libraryUrl(url) : url
  const database = pathDatabase(target)
  const library = opts.library ? { connection: { search_path: PINNED_SEARCH_PATH } } : {}
  if (driver === 'bun') {
    const Bun = (globalThis as any).Bun
    if (!Bun?.SQL) throw new Error("feather-testing-postgres: driver 'bun' needs the Bun runtime; use driver 'postgres-js' under Node")
    make = () => new Bun.SQL(target, { max, database, ...library })
  } else {
    const postgres = (await optionalPeer('postgres')).default
    make = () =>
      postgres(target, { max, database, onnotice: () => {}, ...library, ...(opts.library ? { fetch_types: false } : {}) })
  }
  const end = (pool: any, timeout: number) => (driver === 'bun' ? pool.close({ timeout }) : pool.end({ timeout }))
  let root = make()
  const conn: Conn = {
    kind: driver,
    get client() {
      return root
    },
    get sql() {
      return taggedSql(root)
    },
    async hold(graceMs) {
      const pool = root
      const { tx, release } = await holdOpen((fn) => pool.begin(fn))
      const sched = new Scheduler(graceMs)
      return {
        tx: rawFacade(taggedPort(tx, driver, false), sched, true),
        client: taggedClient(tx, sched, false),
        sql: taggedSql(tx, sched),
        sched,
        release: () => endHeld(sched, release, graceMs, () => conn.retire!()),
      }
    },
    /** Replaces the pool, destroying its connections: an app transaction still
     * suspended on one can never send its ROLLBACK TO / RELEASE into a
     * connection the next test reuses. */
    retire() {
      const old = root
      root = make()
      conn.prepare?.(root)
      // postgres.js closes at once; Bun.sql waits for the held transaction,
      // so the caller rolls it back before awaiting this
      return { closed: Promise.resolve(end(old, 0)).then(() => {}, () => {}) }
    },
    async close(timeoutSeconds = 5) {
      await end(root, timeoutSeconds)
    },
  }
  return conn
}

export async function bootPglite(options: Record<string, unknown> = {}): Promise<Conn & { pg: any }> {
  let mod: any
  try {
    mod = await optionalPeer('@electric-sql/pglite')
  } catch {
    throw new Error("feather-testing-postgres: engine 'pglite' needs @electric-sql/pglite installed")
  }
  const pg = new mod.PGlite(options)
  await pg.waitReady
  return {
    kind: 'pglite',
    pg,
    client: pg,
    sql: pgliteSql(pg),
    async hold(graceMs) {
      const { tx, release } = await holdOpen((fn) => pg.transaction(fn))
      const sched = new Scheduler(graceMs)
      return {
        tx: rawFacade(pglitePort(tx, false), sched, true),
        client: savepointingPgliteTx(tx, sched),
        sql: pgliteSql(tx, sched),
        sched,
        release: () => endHeld(sched, release, graceMs),
      }
    },
    close: () => pg.close(),
  }
}

// ---------------------------------------------------------------------------
// Drizzle, loaded lazily (optional peer).

export async function loadDrizzle(kind: Conn['kind']): Promise<{ drizzle: any; migrate: any } | null> {
  const base = kind === 'bun' ? 'bun-sql' : kind
  try {
    const [d, m] = await Promise.all([
      import(`drizzle-orm/${base}`),
      import(`drizzle-orm/${base}/migrator`),
    ])
    return { drizzle: d.drizzle, migrate: m.migrate }
  } catch {
    return null
  }
}

export function noDrizzle(): any {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        // Not a thenable, and quiet to inspection: fixture runners await
        // the value and tools probe symbols without meaning to use it.
        if (prop === 'then' || typeof prop === 'symbol') return undefined
        throw new Error('feather-testing-postgres: `db` needs drizzle-orm installed (use `sql` for raw SQL)')
      },
    },
  )
}

// ---------------------------------------------------------------------------

export function defaultDriver(): PostgresDriver {
  return (globalThis as any).Bun ? 'bun' : 'postgres-js'
}

export function withDatabase(url: string, name: string): string {
  const u = new URL(url)
  u.pathname = `/${name}`
  // the path names the database: drop any parameter a driver would prefer
  for (const key of [...u.searchParams.keys()])
    if (['database', 'dbname', 'db'].includes(key.toLowerCase())) u.searchParams.delete(key)
  return u.toString()
}
