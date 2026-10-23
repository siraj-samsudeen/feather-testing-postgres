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

import { createHash, randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { CloneGate, DEFAULT_END_TEST_GRACE_MS, serialisingDrizzle, settledWithin } from './scheduler'
import { pglitePort, rawFacade, taggedPort, type RawSql } from './raw'
import { bootPglite, connectPostgres, defaultDriver, hideClient, loadDrizzle, noDrizzle, pgliteInstanceClient, pgliteSql, taggedClient, taggedSql, withDatabase, type Conn } from './drivers'

export type { RawSql } from './raw'

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
  /** Postgres engine: the database to test in. Default, in order:
   * FEATHER_DATABASE_URL, TEST_DATABASE_URL, then DATABASE_URL — the last only
   * when its database is named like a test database (see
   * resolveTestDatabaseUrl). With `clone`, the server's other databases are
   * left alone: the template and clones are created next to this one and
   * dropped afterwards. */
  url?: string
  /** Accept a DATABASE_URL whose database isn't named like a test database.
   * Tests write to (tx: and roll back in; clone: copy next to) it. */
  allowAnyDatabase?: boolean
  /** Postgres engine: default `'bun'` under Bun, `'postgres-js'` elsewhere. */
  driver?: PostgresDriver
  /** Postgres engine, `clone`: connections per test database (default 10) —
   * enough for concurrent app transactions, each of which holds one. (`tx`
   * always uses one: every query runs on the test's transaction.) */
  poolMax?: number
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
  /** Raw SQL through a frozen facade (never a driver object): raw`...`,
   * unsafe and savepoint/begin. See RawSql. */
  raw: RawSql
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

const DEFAULT_CLONE_POOL_MAX = 10

// ---------------------------------------------------------------------------
// raw: a frozen facade of our own. No driver object is ever reachable from it:
// the driver sits behind a private port, held only in closures.

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
    select datname from pg_catalog.pg_database where datname ~ '^feather_(tpl|t)_[0-9a-f]{8}_[0-9]+_'`
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
  allowAnyDatabase?: boolean
}): Promise<string[]> {
  const url = resolveTestDatabaseUrl(opts)
  const c = await connectPostgres(url, opts.driver ?? defaultDriver(), 1)
  try {
    await assertTestDatabase(c.sql, opts)
    return await sweep(c.sql, { anyHost: true, olderThan: opts.olderThan })
  } finally {
    await c.close()
  }
}

/** A database name a test run may use: `test` as a word part — app_test,
 * test, test_db, my-test-db, tests — not contest, latest, testing. */
const TEST_DATABASE_NAME = /(^|[^a-z0-9])tests?([^a-z0-9]|$)/i

/** Query parameters a driver would take the database from instead of the
 * path (postgres.js and Bun.sql both honour `database`). */
const DATABASE_SELECTORS = new Set(['database', 'dbname', 'db'])

function refusal(where: string, name: string): Error {
  return new Error(
    `feather-testing-postgres: refusing ${where} "${name}" — it isn't named like a test database (e.g. app_test). ` +
      'Point FEATHER_DATABASE_URL or TEST_DATABASE_URL at a test database, or pass allowAnyDatabase: true to use this one.',
  )
}

/** The Postgres URL tests may use, never a non-test database by accident: the
 * `url` option, else FEATHER_DATABASE_URL, else TEST_DATABASE_URL, else
 * DATABASE_URL. Whichever it is, the database it names must look like a test
 * database (test as a word part) unless `allowAnyDatabase: true`, and it must
 * name it in its path: a URL selecting the database through a query parameter
 * is refused outright. An empty path is left to the check made after
 * connecting (assertTestDatabase), where the server reports the real database.
 * Throws before any connection is made. */
export function resolveTestDatabaseUrl(
  options: { url?: string; allowAnyDatabase?: boolean } = {},
  env: Record<string, string | undefined> = process.env,
): string {
  const url = options.url ?? env.FEATHER_DATABASE_URL ?? env.TEST_DATABASE_URL ?? env.DATABASE_URL
  if (!url)
    throw new Error(
      "feather-testing-postgres: engine 'postgres' needs a database: set FEATHER_DATABASE_URL (or TEST_DATABASE_URL, or a test-named DATABASE_URL), or pass `url`",
    )
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('feather-testing-postgres: the database URL could not be parsed')
  }
  for (const key of parsed.searchParams.keys())
    if (DATABASE_SELECTORS.has(key.toLowerCase()))
      throw new Error(
        `feather-testing-postgres: refusing a database URL that selects its database outside its path (?${key}=). Name the database in the path.`,
      )
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
  if (!name || options.allowAnyDatabase || TEST_DATABASE_NAME.test(name)) return url
  throw refusal('database', name)
}

/** Drops a template or clone. WITH (FORCE) also ends sessions still on it,
 * but Postgres refuses (42501) when the role isn't allowed to end one of them
 * — a CREATEDB-only role and an autovacuum worker; a plain DROP may stop
 * autovacuum itself, so that is the fallback. */
export async function dropDatabase(sql: SqlRunner, name: string): Promise<void> {
  const quoted = `"${name.replace(/"/g, '""')}"`
  try {
    await sql.unsafe(`drop database if exists ${quoted} with (force)`)
  } catch (e) {
    // SQLSTATE: postgres.js reports it as `code`, Bun.sql as `errno`
    const { code, errno } = (e ?? {}) as { code?: string; errno?: string }
    if (code !== '42501' && errno !== '42501') throw e
    await sql.unsafe(`drop database if exists ${quoted}`)
  }
}

/** The check after connecting: the server's own current_database() — what a
 * URL's path, PGDATABASE, a driver's defaults or anything else resolved to.
 * `expected`: exactly this database (a template or clone we created);
 * otherwise it must be named like a test database unless allowAnyDatabase. */
export async function assertTestDatabase(
  sql: SqlRunner,
  options: { allowAnyDatabase?: boolean; expected?: string } = {},
): Promise<void> {
  // schema-qualified: a current_database() earlier on search_path can't answer
  const [{ db }] = await sql<{ db: string }>`select pg_catalog.current_database() as db`
  if (options.expected !== undefined) {
    if (db !== options.expected)
      throw new Error(`feather-testing-postgres: connected to database "${db}", expected "${options.expected}"`)
    return
  }
  if (!options.allowAnyDatabase && !TEST_DATABASE_NAME.test(db)) throw refusal('the connected database', db)
}

export function createFeatherDb<TDb = any>(options: FeatherDbOptions = {}): FeatherDb<TDb> {
  const engine = (options.engine ?? (process.env.FEATHER_DB as EngineName | undefined) ?? 'pglite') as EngineName
  if (engine !== 'pglite' && engine !== 'postgres')
    throw new Error(`feather-testing-postgres: unknown engine '${engine}' (use 'pglite' or 'postgres')`)
  const strategy = options.strategy ?? 'tx'
  if (strategy !== 'tx' && strategy !== 'clone')
    throw new Error(`feather-testing-postgres: unknown strategy '${strategy}' (use 'tx' or 'clone')`)
  const driver = options.driver ?? defaultDriver()

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
  const graceMs = options.endTestGraceMs ?? DEFAULT_END_TEST_GRACE_MS

  const makeDb = (client: unknown) =>
    drz ? drz.drizzle({ client, schema: options.schema }) : noDrizzle()

  // resolved (and safety-checked) when the postgres engine starts
  let url: string | undefined
  function requireUrl(): string {
    return (url ??= resolveTestDatabaseUrl(options))
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
      await assertTestDatabase(tpl.sql, { expected: templateName! })
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
      // the server's own answer is checked before anything runs there
      if (strategy === 'tx') {
        conn = await connectPostgres(u, driver, 1)
        await assertTestDatabase(conn.sql, options)
      } else {
        admin = await connectPostgres(u, driver, 1)
        await assertTestDatabase(admin.sql, options)
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
          const h = await conn!.hold(graceMs)
          end = h.release
          return { db: drz ? serialisingDrizzle(makeDb(h.client), h.sched) : makeDb(h.client), sql: h.sql, raw: h.tx }
        }
        if (engine === 'pglite') {
          const c = await bootPglite({ ...options.pglite, loadDataDir: snapshot })
          const gate = new CloneGate()
          end = async () => {
            // refuse new work, let in-flight work finish (bounded), then close;
            // past the grace the instance is abandoned rather than awaited
            gate.ended = true
            const settled = await settledWithin([...gate.inflight], graceMs)
            gate.closed = true
            const closing = c.close()
            if (settled) await closing
            else await settledWithin([closing], graceMs)
          }
          return {
            db: drz ? hideClient(makeDb(pgliteInstanceClient(c.pg, gate))) : makeDb(c.client),
            sql: pgliteSql(c.pg, gate),
            raw: rawFacade(pglitePort(c.pg, true), gate, false),
          }
        }
        const name = `feather_t_${HOST_ID}_${process.pid}_${Date.now().toString(36)}_${instanceId}_${++cloneSeq}`
        const drop = () => dropDatabase(admin!.sql, name)
        await admin!.sql.unsafe(`create database "${name}" template "${templateName}"`)
        let c: Conn | undefined
        try {
          c = await connectPostgres(withDatabase(requireUrl(), name), driver, options.poolMax ?? DEFAULT_CLONE_POOL_MAX)
          await assertTestDatabase(c.sql, { expected: name })
        } catch (e) {
          await c?.close(0).catch(() => {})
          await drop().catch(() => {})
          throw e
        }
        const gate = new CloneGate()
        end = async () => {
          // refuse new work, let in-flight work finish (bounded), then close;
          // past the grace, DROP … WITH (FORCE) terminates its connections
          gate.ended = true
          const settled = await settledWithin([...gate.inflight], graceMs)
          gate.closed = true
          if (settled) {
            await c.close()
            await drop()
          } else {
            // force-close the pool first (the driver retires its own sockets),
            // then the server-side drop ends anything still attached
            const closing = c.close(0).catch(() => {})
            await drop().catch(() => {})
            await settledWithin([closing], graceMs)
          }
        }
        // drizzle's postgres-js setup configures the clone pool's parsers; the
        // db itself runs on our adapter
        if (drz) drz.drizzle({ client: c.client })
        return {
          db: drz ? hideClient(makeDb(taggedClient(c.client, gate, true))) : makeDb(c.client),
          sql: taggedSql(c.client, gate),
          raw: rawFacade(taggedPort(c.client, driver, true), gate, false),
        }
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
          await dropDatabase(admin.sql, templateName)
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
