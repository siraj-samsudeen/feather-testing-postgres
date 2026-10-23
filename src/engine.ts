// Engines and isolation strategies, independent of any test runner.
//
//   engine   — where the database lives: `pglite` (in-process WASM Postgres,
//              nothing to install) or `postgres` (a real server, reached with
//              Bun.sql under Bun or postgres.js under Node).
//   strategy — how one test is isolated from the next:
//              `tx`    one transaction per test, always rolled back; the app's
//                      own transactions become SAVEPOINTs inside it.
//              `clone` a fresh database per test, copied from a migrated
//                      template (CREATE DATABASE … TEMPLATE on Postgres, a
//                      dumpDataDir snapshot on PGlite). Real COMMITs, for
//                      commit-dependent code.
//
// The lifecycle is four calls — start(), beginTest(), endTest(), close() — so
// any runner (bun:test hooks, Vitest fixtures, a fixture engine) can drive it.
// beginTest() hands back a Drizzle handle bound to the test's database or
// transaction: the app takes it by injection (`createApp({ db })`), so no
// global delegate or SQL proxy is needed.
//
// Every driver is loaded lazily, so a consumer installs only what its engine
// needs (@electric-sql/pglite, postgres, drizzle-orm are optional peers; Bun.sql
// is built into Bun).

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomBytes } from 'node:crypto'
import { hostname } from 'node:os'

export type EngineName = 'pglite' | 'postgres'
export type IsolationStrategy = 'tx' | 'clone'
export type PostgresDriver = 'bun' | 'postgres-js'

/** Raw SQL against the test's database: a tagged template returning rows, plus
 * `unsafe(text, params)` for SQL built at runtime. Same shape on every engine. */
export interface SqlRunner {
  <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>
  unsafe<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>
}

export interface FeatherDbOptions {
  /** Default: `process.env.FEATHER_DB`, else `'pglite'` — a fresh clone tests
   * with nothing installed. */
  engine?: EngineName
  /** Default `'tx'`. Use `'clone'` per file for code that depends on COMMIT. */
  strategy?: IsolationStrategy
  /** Postgres engine: the database to test in. Default `process.env.DATABASE_URL`.
   * With `clone`, the server's other databases are left alone: the template
   * and clones are created next to this one and dropped afterwards. */
  url?: string
  /** Postgres engine: default `'bun'` under Bun, `'postgres-js'` elsewhere. */
  driver?: PostgresDriver
  /** A drizzle-kit migrations folder applied once, in start(). */
  migrations?: string
  /** Runs once after migrations (tx: on the database; clone: on the template). */
  setup?: (sql: SqlRunner) => unknown | Promise<unknown>
  /** Passed to drizzle(), enabling `db.query.<table>`. */
  schema?: Record<string, unknown>
  /** How long endTest() lets app transactions still running settle inside
   * the test transaction before rolling it back (default 2000 ms). Past it,
   * the Postgres engine destroys that connection rather than reuse it. */
  endTestGraceMs?: number
  /** PGlite constructor options, e.g. `{ extensions: { vector } }`. Extensions
   * must be imported as PGlite modules; `CREATE EXTENSION` alone is not enough. */
  pglite?: Record<string, unknown>
}

export interface TestDb<TDb = any> {
  /** Drizzle handle bound to this test's transaction (tx) or database (clone).
   * Hand it to the app: `createApp({ db })`. `db.transaction()` becomes a
   * SAVEPOINT under `tx`. Requires drizzle-orm. */
  db: TDb
  /** Raw SQL on the same transaction/database as `db`. */
  sql: SqlRunner
  /** The driver's own handle (Bun.sql / postgres.js transaction, PGlite
   * transaction, or the clone's client) for anything the above doesn't cover. */
  raw: unknown
}

export interface FeatherDb<TDb = any> {
  readonly engine: EngineName
  readonly strategy: IsolationStrategy
  /** Boots the engine, applies `migrations` and `setup`. Idempotent. */
  start(): Promise<void>
  /** Applies a drizzle-kit migrations folder once (tx: to the database; clone:
   * to the template). Repeat calls for the same folder are no-ops. */
  migrateOnce(folder: string): Promise<void>
  /** Opens this test's isolation unit. One at a time: tests must run
   * sequentially (bun:test runs files one after another; never test.concurrent). */
  beginTest(): Promise<TestDb<TDb>>
  /** Rolls back (tx) or discards (clone) what the test did. */
  endTest(): Promise<void>
  close(): Promise<void>
}

// ---------------------------------------------------------------------------
// Driver adapters: one small interface over Bun.sql, postgres.js and PGlite.

interface Conn {
  /** Called on each new pool (drizzle's postgres-js parsers live on it). */
  prepare?: (client: unknown) => void
  /** Replace the pool and start closing the old one (Postgres only); the
   * returned promise settles when the old pool is closed. */
  retire?: () => { closed: Promise<void> }
  sql: SqlRunner
  /** Runs fn in a transaction that the caller controls through `release`. */
  hold(graceMs: number): Promise<{ tx: unknown; client: unknown; sql: SqlRunner; sched: Scheduler; release(): Promise<void> }>
  /** The client drizzle should be built over when no test transaction is held. */
  client: unknown
  kind: 'bun' | 'postgres-js' | 'pglite'
  close(): Promise<void>
}

class Rollback extends Error {
  constructor() {
    super('feather-testing-postgres: test rollback (this should never surface)')
  }
}

/** Opens a callback-style transaction and keeps it open until release(). The
 * thrown sentinel makes every driver ROLLBACK, on pass and fail alike. */
async function holdOpen(
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

function templateToText(strings: TemplateStringsArray, values: unknown[]): string {
  return strings.reduce((acc, s, i) => acc + (i > 0 ? `$${i}` : '') + s, '')
}

/** Bun.sql and postgres.js: a tagged-template client. */
function taggedSql(client: any, sched?: Scheduler): SqlRunner {
  const q = <T>(fn: () => T | PromiseLike<T>) => (sched ? sched.query(fn) : Promise.resolve().then(fn))
  const run = (async (strings: TemplateStringsArray, ...values: unknown[]) =>
    Array.from(await q(() => client(strings, ...values)))) as SqlRunner
  run.unsafe = async (text, params) => Array.from(await q(() => client.unsafe(text, params ?? [])))
  return run
}

/** PGlite: query(text, params). */
function pgliteSql(client: any, sched?: Scheduler): SqlRunner {
  const q = <T>(fn: () => T | PromiseLike<T>) => (sched ? sched.query(fn) : Promise.resolve().then(fn))
  const run = (async (strings: TemplateStringsArray, ...values: unknown[]) =>
    (await q(() => client.query(templateToText(strings, values), values))).rows) as SqlRunner
  run.unsafe = async (text, params) => (await q(() => client.query(text, params ?? []))).rows
  return run
}

/** One node per open transaction (the root is the test itself). */
interface TxNode {
  real: any
  /** Work queued under this node: its child transactions, in order. */
  tail: Promise<unknown>
  /** Set once the node's own callback has failed: children not yet started
   * are cancelled rather than run inside a savepoint about to roll back. */
  failed: boolean
  /** The transaction machinery's own SQL (SAVEPOINT / RELEASE / ROLLBACK TO). */
  passthrough?: boolean
}

const OPENING: TxNode = { real: null, tail: Promise.resolve(), failed: false, passthrough: true }

/** Serialises everything that shares one test transaction. Under `tx` every
 * app transaction is a SAVEPOINT on the test's single connection, so work in
 * flight together interleaves: siblings release or roll back each other's
 * savepoints, and a plain write lands inside whichever savepoint happens to be
 * open (and vanishes with it). So:
 * - a transaction queues behind its siblings under its parent — the innermost
 *   transaction running in the current async context, else the handle it was
 *   called on — and settles only after its own children have;
 * - a plain query (db or sql) waits for the transactions open under its
 *   context: outside any, until they finish; inside one, it runs in that
 *   transaction (after that transaction's own children), never deadlocking.
 * Concurrent requests in one test are therefore serialised. */
class Scheduler {
  readonly active = new AsyncLocalStorage<TxNode>()
  readonly root: TxNode = { real: null, tail: Promise.resolve(), failed: false }
  /** Set when endTest() begins: from then on nothing may reach the connection
   * (after the test transaction ends, postgres.js would autocommit it). */
  ended = false
  /** Set once the test transaction is rolled back: not even the savepoint
   * machinery may run (while draining, it still rolls savepoints back). */
  closed = false

  endedError(): Error {
    return new Error(
      "feather-testing-postgres: this test has ended — a query ran after endTest; await your app's work before the test finishes",
    )
  }

  /** Throws if the test has ended. */
  check(): void {
    if (this.ended) throw this.endedError()
  }

  query<T>(fn: () => T | PromiseLike<T>): Promise<T> {
    const n = this.active.getStore() ?? this.root
    // checked when issued and again when its queued turn comes
    const go = () => {
      this.check()
      return fn()
    }
    if (n.passthrough) return (async () => go())()
    if (this.ended) return Promise.reject(this.endedError())
    return n.tail.then(go)
  }
}

/** Ends a held test transaction: refuse new work, let in-flight app
 * transactions settle (their next query fails fast, and their savepoints roll
 * back inside the still-open test transaction rather than on the bare
 * connection), then roll the test transaction back. The wait is bounded so
 * app code that never settles cannot hang endTest(). */
async function endHeld(
  sched: Scheduler,
  release: () => Promise<void>,
  graceMs: number,
  retire?: () => { closed: Promise<void> },
): Promise<void> {
  sched.ended = true
  let timer: ReturnType<typeof setTimeout> | undefined
  const settled = await Promise.race([
    sched.root.tail.then(() => true),
    new Promise<boolean>((r) => {
      timer = setTimeout(() => r(false), graceMs)
    }),
  ])
  clearTimeout(timer)
  try {
    if (!settled && retire) {
      // Still suspended app work would later send its own savepoint cleanup
      // on this connection — by then possibly the next test's. Destroy the
      // connection instead of handing it back (the server rolls back).
      const { closed } = retire()
      await release().catch(() => {})
      await closed
    } else await release()
  } finally {
    sched.closed = true
  }
}

const DEFAULT_END_TEST_GRACE_MS = 2000

/** A query object guarded at execution as well as creation. Bun.sql and
 * postgres.js queries are lazy: built before endTest and awaited (or
 * .execute()d, .values()d, ...) after it, they would run on the bare
 * connection. Every method — whatever starts the query — checks first;
 * methods returning the query itself keep it guarded. */
function guardQuery<T>(q: T, sched: Scheduler): T {
  if (!q || (typeof q !== 'object' && typeof q !== 'function')) return q
  const proxy: any = new Proxy(q as any, {
    get(target, prop) {
      const v = target[prop]
      if (typeof v !== 'function') return v
      return (...args: unknown[]) => {
        sched.check()
        const r = v.apply(target, args)
        return r === target ? proxy : r
      }
    },
  })
  return proxy
}

/** The driver's own transaction handle, refusing use once the test ended —
 * when a query is created and again when it starts. */
function guardRaw(handle: any, sched: Scheduler): unknown {
  return new Proxy(handle, {
    get(target, prop) {
      const v = target[prop]
      if (typeof v !== 'function') return v
      return (...args: unknown[]) => {
        sched.check()
        return guardQuery(v.apply(target, args), sched)
      }
    },
    apply(target, _this, args) {
      sched.check()
      return guardQuery(target(...args), sched)
    },
  })
}

function newNode(real: any): TxNode {
  return { real, tail: Promise.resolve(), failed: false }
}

function serialisingDrizzle(rootDb: any, sched: Scheduler): any {
  const { active } = sched
  sched.root.real = rootDb
  const wrap = (real: any, own: TxNode): any =>
    new Proxy(real, {
      get(target, prop) {
        if (prop === 'transaction')
          return (fn: (tx: unknown) => Promise<unknown>, config?: unknown) => {
            const parent = active.getStore() ?? own
            if (sched.ended) return Promise.reject(sched.endedError())
            const run = parent.tail.then(() => {
              sched.check()
              if (parent.failed)
                throw new Error(
                  'feather-testing-postgres: transaction cancelled — its parent transaction failed before it started',
                )
              return active.run(OPENING, () =>
                parent.real.transaction(async (inner: any) => {
                  const self = newNode(inner)
                  let result: unknown
                  try {
                    result = await active.run(self, () => fn(wrap(inner, self)))
                  } catch (e) {
                    // Cancel children still queued, let a running one finish
                    // (it rolls back its own savepoint), then fail: the
                    // savepoint is never released or rolled back under them.
                    self.failed = true
                    await self.tail
                    throw e
                  }
                  // Settle only after every child has: a parent never
                  // finishes while a child's savepoint is open.
                  await self.tail
                  return result
                }, config),
              )
            })
            parent.tail = run.catch(() => {})
            return run
          }
        const v = Reflect.get(target, prop)
        return typeof v === 'function' ? v.bind(target) : v
      },
    })
  return wrap(rootDb, sched.root)
}

/** A Bun.sql / postgres.js transaction handle whose `begin` opens a SAVEPOINT,
 * so drizzle's `db.transaction()` nests instead of issuing BEGIN. */
function savepointingTaggedTx(tx: any, root: any, sched: Scheduler): unknown {
  const savepoint = (target: any) => (a: unknown, b?: unknown) => {
    sched.check()
    const fn = (typeof a === 'function' ? a : b) as (h: unknown) => unknown
    // the handle drizzle runs the transaction's queries on: gated as well
    return target.savepoint((h: any) => fn(adapt(h)))
  }
  const adapt = (handle: any): any =>
    new Proxy(handle, {
      get(target, prop) {
        // drizzle's postgres-js driver installs parsers on client.options; a
        // transaction shares its root's connection and options.
        if (prop === 'options' && target.options === undefined) return root.options
        if (prop === 'begin' || prop === 'savepoint') return savepoint(target)
        if (prop === 'unsafe')
          return (query: string, params?: unknown[]) => {
            // drizzle calls client.unsafe(q, p) and client.unsafe(q, p).values()
            const exec = (f: (r: any) => unknown) => sched.query(() => f(target.unsafe(query, params)))
            return {
              values: () => exec((r) => r.values()),
              then: (ok: any, ko: any) => exec((r) => r).then(ok, ko),
            }
          }
        const v = target[prop]
        return typeof v === 'function' ? v.bind(target) : v
      },
      apply: (target, _this, args) => sched.query(() => target(...args)),
    })
  return adapt(tx)
}

/** A PGlite transaction whose `transaction()` opens a SAVEPOINT (drizzle's
 * pglite session calls client.transaction for db.transaction()). */
function savepointingPgliteTx(tx: any, sched: Scheduler): unknown {
  let n = 0
  const client: any = {
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
  }
  return client
}

/** Loads an optional peer. The specifier is not a literal, so TypeScript does
 * not resolve it: a consumer without that peer installed still type-checks
 * this source (it ships as .ts). */
const optionalPeer = (name: string): Promise<any> => import(/* @vite-ignore */ name)

async function connectPostgres(url: string, driver: PostgresDriver, max = 2): Promise<Conn> {
  let make: () => any
  if (driver === 'bun') {
    const Bun = (globalThis as any).Bun
    if (!Bun?.SQL) throw new Error("feather-testing-postgres: driver 'bun' needs the Bun runtime; use driver 'postgres-js' under Node")
    make = () => new Bun.SQL(url, { max })
  } else {
    const postgres = (await optionalPeer('postgres')).default
    make = () => postgres(url, { max, onnotice: () => {} })
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
      const sched = new Scheduler()
      return {
        tx: guardRaw(tx, sched),
        client: savepointingTaggedTx(tx, pool, sched),
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
    async close() {
      await end(root, 5)
    },
  }
  return conn
}

async function bootPglite(options: Record<string, unknown> = {}): Promise<Conn & { pg: any }> {
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
      const sched = new Scheduler()
      return {
        tx: guardRaw(tx, sched),
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

async function loadDrizzle(kind: Conn['kind']): Promise<{ drizzle: any; migrate: any } | null> {
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

function noDrizzle(): any {
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

function defaultDriver(): PostgresDriver {
  return (globalThis as any).Bun ? 'bun' : 'postgres-js'
}

function withDatabase(url: string, name: string): string {
  const u = new URL(url)
  u.pathname = `/${name}`
  return u.toString()
}

let cloneSeq = 0

function pidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM' // exists, not ours to signal
  }
}

/** This host's id in generated database names: the first 8 hex digits of
 * sha1(hostname). A pid is only meaningful on the host that issued it. */
const HOST_ID = createHash('sha1').update(hostname()).digest('hex').slice(0, 8)

/** Generated names: feather_tpl_<host>_<pid>_<created, base36 ms>[_…] and
 * feather_t_<host>_<pid>_<created>[_…]. */
const NAME = /^feather_(?:tpl|t)_([0-9a-f]{8})_([0-9]+)_([0-9a-z]+)(?:_|$)/

/** Default age before a leftover may be dropped. */
const STALE_AFTER_MS = 3600_000

async function sweep(sql: SqlRunner, opts: { anyHost: boolean; olderThan: number }): Promise<string[]> {
  const rows = await sql<{ datname: string }>`
    select datname from pg_database where datname ~ '^feather_(tpl|t)_[0-9a-f]{8}_[0-9]+_'`
  const dropped: string[] = []
  for (const { datname } of rows) {
    const m = NAME.exec(datname)
    if (!m) continue
    const [, host, pidText, created] = m
    const pid = Number(pidText)
    const ours = host === HOST_ID
    if (!ours && !opts.anyHost) continue
    // a live process on this host owns it (and we never touch our own)
    if (ours && (pid === process.pid || pidRunning(pid))) continue
    const age = Date.now() - parseInt(created, 36)
    if (!(age > opts.olderThan)) continue
    // never forced: a database anyone is connected to stays
    const ok = await sql.unsafe(`drop database if exists "${datname.replace(/"/g, '""')}"`).then(
      () => true,
      () => false,
    )
    if (ok) dropped.push(datname)
  }
  return dropped
}

/** Explicit cleanup of databases left by crashed runs. Nothing is dropped
 * automatically: a hostname is not a pid namespace (containers share
 * hostnames), so no engine can prove another run's template abandoned. Drops
 * feather_tpl_* / feather_t_* databases created more than `olderThan` ms ago,
 * skipping this host's live pids, never forced (a connected database stays).
 * Run it where no other test run shares the server — e.g. a CI setup step.
 * Returns the names dropped. */
export async function cleanupStale(opts: {
  olderThan: number
  url?: string
  driver?: PostgresDriver
}): Promise<string[]> {
  const url = opts.url ?? process.env.DATABASE_URL
  if (!url) throw new Error('feather-testing-postgres: cleanupStale needs DATABASE_URL (or the `url` option)')
  const c = await connectPostgres(url, opts.driver ?? defaultDriver(), 1)
  try {
    return await sweep(c.sql, { anyHost: true, olderThan: opts.olderThan })
  } finally {
    await c.close()
  }
}

export function createFeatherDb<TDb = any>(options: FeatherDbOptions = {}): FeatherDb<TDb> {
  const engine = (options.engine ?? (process.env.FEATHER_DB as EngineName | undefined) ?? 'pglite') as EngineName
  if (engine !== 'pglite' && engine !== 'postgres')
    throw new Error(`feather-testing-postgres: unknown engine '${engine}' (use 'pglite' or 'postgres')`)
  const strategy = options.strategy ?? 'tx'
  if (strategy !== 'tx' && strategy !== 'clone')
    throw new Error(`feather-testing-postgres: unknown strategy '${strategy}' (use 'tx' or 'clone')`)
  const driver = options.driver ?? defaultDriver()
  const url = options.url ?? process.env.DATABASE_URL

  // per folder: the migration, in flight or done (dropped if it fails), so
  // concurrent calls for one folder share one run
  const migrated = new Map<string, Promise<void>>()
  let starting: Promise<void> | null = null
  let drz: { drizzle: any; migrate: any } | null = null

  // tx strategy: one long-lived connection; each test holds a transaction on it.
  let conn: Conn | null = null
  // clone strategy, Postgres: an admin connection plus a template database.
  let admin: Conn | null = null
  let templateName: string | null = null
  // Only a template this engine created is ever dropped by it.
  let templateCreated = false
  // Per-instance: two engines started in the same millisecond never share names.
  const instanceId = randomBytes(4).toString('hex')
  // clone strategy, PGlite: a migrated base instance and its snapshot.
  let base: (Conn & { pg: any }) | null = null
  let snapshot: Blob | null = null

  let current: { ready: Promise<void>; end(): Promise<void> } | null = null

  const makeDb = (client: unknown) =>
    drz ? drz.drizzle({ client, schema: options.schema }) : noDrizzle()

  function requireUrl(): string {
    if (!url)
      throw new Error("feather-testing-postgres: engine 'postgres' needs DATABASE_URL (or the `url` option)")
    return url
  }

  /** Runs fn against the place migrations go: the database (tx) or template (clone). */
  async function onTarget(fn: (c: Conn) => Promise<void>) {
    if (strategy === 'tx') return fn(conn!)
    if (engine === 'pglite') {
      await fn(base!)
      snapshot = await base!.pg.dumpDataDir('none')
      return
    }
    const tpl = await connectPostgres(withDatabase(requireUrl(), templateName!), driver, 1)
    try {
      await fn(tpl)
    } finally {
      // CREATE DATABASE … TEMPLATE refuses while anyone is connected to it.
      await tpl.close()
    }
  }

  async function applyMigrations(c: Conn, folder: string) {
    const d = drz ?? (await loadDrizzle(c.kind))
    if (!d) throw new Error('feather-testing-postgres: migrateOnce needs drizzle-orm installed')
    await d.migrate(d.drizzle({ client: c.client }), { migrationsFolder: folder })
  }

  async function doStart() {
    if (engine === 'pglite') {
      const c = await bootPglite(options.pglite)
      if (strategy === 'tx') conn = c
      else base = c
      drz = await loadDrizzle('pglite')
    } else {
      const u = requireUrl()
      // tx needs one connection: every test query runs on its transaction
      if (strategy === 'tx') conn = await connectPostgres(u, driver, 1)
      else {
        admin = await connectPostgres(u, driver, 1)
        templateName = `feather_tpl_${HOST_ID}_${process.pid}_${Date.now().toString(36)}_${instanceId}`
        await admin.sql.unsafe(`create database "${templateName}"`)
        templateCreated = true
      }
      drz = await loadDrizzle(driver)
      // postgres-js: drizzle() configures the root client's parsers once, so
      // test transactions (which share them) parse dates/json the same way.
      if (drz && conn) {
        const d = drz
        conn.prepare = (client) => d.drizzle({ client })
        conn.prepare(conn.client)
      }
    }
    const folders = [...(options.migrations ? [options.migrations] : [])]
    await onTarget(async (c) => {
      for (const f of folders) {
        await applyMigrations(c, f)
        migrated.set(f, Promise.resolve())
      }
      await options.setup?.(c.sql)
    })
  }

  const self: FeatherDb<TDb> = {
    engine,
    strategy,

    start() {
      return (starting ??= doStart())
    },

    async migrateOnce(folder) {
      await self.start()
      const known = migrated.get(folder)
      if (known) return known
      if (current) throw new Error('feather-testing-postgres: call migrateOnce outside a test (beforeAll)')
      const run = onTarget((c) => applyMigrations(c, folder))
      migrated.set(folder, run)
      run.catch(() => {
        if (migrated.get(folder) === run) migrated.delete(folder)
      })
      return run
    },

    async beginTest() {
      // Claim the one test slot before the first await, so racing calls
      // cannot both open a test (an untracked transaction or clone would leak).
      if (current)
        throw new Error(
          'feather-testing-postgres: beginTest() while a test is open — tests sharing a FeatherDb must run sequentially (no test.concurrent)',
        )
      let end: () => Promise<void> = async () => {}
      let opened!: () => void
      const slot = { ready: new Promise<void>((r) => (opened = r)), end: () => end() }
      current = slot
      try {
        await self.start()
        if (strategy === 'tx') {
          const h = await conn!.hold(options.endTestGraceMs ?? DEFAULT_END_TEST_GRACE_MS)
          end = h.release
          return { db: drz ? serialisingDrizzle(makeDb(h.client), h.sched) : makeDb(h.client), sql: h.sql, raw: h.tx }
        }
        if (engine === 'pglite') {
          const c = await bootPglite({ ...options.pglite, loadDataDir: snapshot })
          end = () => c.close()
          return { db: makeDb(c.client), sql: c.sql, raw: c.pg }
        }
        const name = `feather_t_${HOST_ID}_${process.pid}_${Date.now().toString(36)}_${instanceId}_${++cloneSeq}`
        const drop = () => admin!.sql.unsafe(`drop database if exists "${name}" with (force)`)
        await admin!.sql.unsafe(`create database "${name}" template "${templateName}"`)
        let c: Conn
        try {
          c = await connectPostgres(withDatabase(requireUrl(), name), driver)
        } catch (e) {
          await drop().catch(() => {})
          throw e
        }
        end = async () => {
          await c.close()
          await drop()
        }
        return { db: makeDb(c.client), sql: c.sql, raw: c.client }
      } catch (e) {
        if (current === slot) current = null
        throw e
      } finally {
        opened()
      }
    },

    async endTest() {
      const c = current
      if (!c) return
      try {
        await c.ready
        await c.end()
      } finally {
        // held until teardown completes, so a beginTest() racing endTest() is refused
        if (current === c) current = null
      }
    },

    async close() {
      if (!starting) return
      await starting.catch(() => {})
      await self.endTest()
      await conn?.close()
      await base?.close()
      if (admin) {
        if (templateName && templateCreated)
          await admin.sql.unsafe(`drop database if exists "${templateName}" with (force)`)
        templateName = null
        templateCreated = false
        await admin.close()
      }
      conn = base = admin = null
      starting = null
      migrated.clear()
    },
  }
  return self
}
