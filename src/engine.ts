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
  sql: SqlRunner
  /** Runs fn in a transaction that the caller controls through `release`. */
  hold(): Promise<{ tx: unknown; client: unknown; sql: SqlRunner; release(): Promise<void> }>
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
function taggedSql(client: any): SqlRunner {
  const run = (async (strings: TemplateStringsArray, ...values: unknown[]) =>
    Array.from(await client(strings, ...values))) as SqlRunner
  run.unsafe = async (text, params) => Array.from(await client.unsafe(text, params ?? []))
  return run
}

/** PGlite: query(text, params). */
function pgliteSql(client: any): SqlRunner {
  const run = (async (strings: TemplateStringsArray, ...values: unknown[]) =>
    (await client.query(templateToText(strings, values), values)).rows) as SqlRunner
  run.unsafe = async (text, params) => (await client.query(text, params ?? [])).rows
  return run
}

/** Serialises sibling app transactions at every level of one test handle.
 * Under `tx` every app transaction is a SAVEPOINT on the test's single
 * connection, so siblings in flight together interleave (releasing one drops
 * the other; rolling one back undoes the other's writes). Each transaction is
 * a node with its own queue: a new transaction queues behind its siblings
 * under its parent — the innermost transaction running in the current async
 * context, else the handle it was called on — and opens through the parent's
 * real handle. So `tx.transaction()` and the outer `db.transaction()` called
 * inside a transaction both nest under it, and nesting never waits on itself. */
function serialisingDrizzle(rootDb: any): any {
  interface Node {
    real: any
    tail: Promise<unknown>
  }
  const active = new AsyncLocalStorage<Node>()
  const wrap = (real: any, own: Node): any =>
    new Proxy(real, {
      get(target, prop) {
        if (prop === 'transaction')
          return (fn: (tx: unknown) => Promise<unknown>, config?: unknown) => {
            const parent = active.getStore() ?? own
            const run = parent.tail.then(() =>
              parent.real.transaction((inner: any) => {
                const node: Node = { real: inner, tail: Promise.resolve() }
                return active.run(node, () => fn(wrap(inner, node)))
              }, config),
            )
            parent.tail = run.catch(() => {})
            return run
          }
        const v = Reflect.get(target, prop)
        return typeof v === 'function' ? v.bind(target) : v
      },
    })
  return wrap(rootDb, { real: rootDb, tail: Promise.resolve() })
}

/** A Bun.sql / postgres.js transaction handle whose `begin` opens a SAVEPOINT,
 * so drizzle's `db.transaction()` nests instead of issuing BEGIN. */
function savepointingTaggedTx(tx: any, root: any): unknown {
  return new Proxy(tx, {
    get(target, prop) {
      // drizzle's postgres-js driver installs parsers on client.options; a
      // transaction shares its root's connection and options.
      if (prop === 'options' && target.options === undefined) return root.options
      if (prop === 'begin')
        return (a: unknown, b?: unknown) => target.savepoint(typeof a === 'function' ? a : b)
      const v = target[prop]
      return typeof v === 'function' ? v.bind(target) : v
    },
    apply: (target, _this, args) => target(...args),
  })
}

/** A PGlite transaction whose `transaction()` opens a SAVEPOINT (drizzle's
 * pglite session calls client.transaction for db.transaction()). */
function savepointingPgliteTx(tx: any): unknown {
  let n = 0
  const client: any = {
    query: (...a: unknown[]) => tx.query(...a),
    exec: (...a: unknown[]) => tx.exec(...a),
    async transaction(fn: (c: unknown) => Promise<unknown>) {
      const name = `feather_sp_${++n}`
      await tx.query(`savepoint ${name}`)
      try {
        const result = await fn(client)
        await tx.query(`release savepoint ${name}`)
        return result
      } catch (e) {
        await tx.query(`rollback to savepoint ${name}`)
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
  let root: any
  if (driver === 'bun') {
    const Bun = (globalThis as any).Bun
    if (!Bun?.SQL) throw new Error("feather-testing-postgres: driver 'bun' needs the Bun runtime; use driver 'postgres-js' under Node")
    root = new Bun.SQL(url, { max })
  } else {
    const postgres = (await optionalPeer('postgres')).default
    root = postgres(url, { max, onnotice: () => {} })
  }
  return {
    kind: driver,
    client: root,
    sql: taggedSql(root),
    async hold() {
      const { tx, release } = await holdOpen((fn) => root.begin(fn))
      return { tx, client: savepointingTaggedTx(tx, root), sql: taggedSql(tx), release }
    },
    async close() {
      if (driver === 'bun') await root.close()
      else await root.end({ timeout: 5 })
    },
  }
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
    async hold() {
      const { tx, release } = await holdOpen((fn) => pg.transaction(fn))
      return { tx, client: savepointingPgliteTx(tx), sql: pgliteSql(tx), release }
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

  const migrated = new Set<string>()
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
      if (strategy === 'tx') conn = await connectPostgres(u, driver)
      else {
        admin = await connectPostgres(u, driver, 1)
        templateName = `feather_tpl_${HOST_ID}_${process.pid}_${Date.now().toString(36)}_${instanceId}`
        await admin.sql.unsafe(`create database "${templateName}"`)
        templateCreated = true
      }
      drz = await loadDrizzle(driver)
      // postgres-js: drizzle() configures the root client's parsers once, so
      // test transactions (which share them) parse dates/json the same way.
      if (drz && conn) drz.drizzle({ client: conn.client })
    }
    const folders = [...(options.migrations ? [options.migrations] : [])]
    await onTarget(async (c) => {
      for (const f of folders) {
        await applyMigrations(c, f)
        migrated.add(f)
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
      if (migrated.has(folder)) return
      if (current) throw new Error('feather-testing-postgres: call migrateOnce outside a test (beforeAll)')
      await onTarget((c) => applyMigrations(c, folder))
      migrated.add(folder)
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
          const h = await conn!.hold()
          end = h.release
          return { db: drz ? serialisingDrizzle(makeDb(h.client)) : makeDb(h.client), sql: h.sql, raw: h.tx }
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
