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

interface Conn {
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
/** Where a test's queries are admitted: the tx scheduler or a clone's gate.
 * Both refuse once the test ended and know what is still in flight. */
interface QueryGate {
  check(): void
  query<T>(fn: () => T | PromiseLike<T>): Promise<T>
  track(work: Promise<unknown>): void
}

function taggedSql(client: any, gate?: QueryGate): SqlRunner {
  const q = <T>(fn: () => T | PromiseLike<T>) => (gate ? gate.query(fn) : Promise.resolve().then(fn))
  const run = (async (strings: TemplateStringsArray, ...values: unknown[]) =>
    Array.from(await q(() => client(strings, ...values)))) as SqlRunner
  run.unsafe = async (text, params) => Array.from(await q(() => client.unsafe(text, params ?? [])))
  return run
}

/** PGlite: query(text, params). */
function pgliteSql(client: any, gate?: QueryGate): SqlRunner {
  const q = <T>(fn: () => T | PromiseLike<T>) => (gate ? gate.query(fn) : Promise.resolve().then(fn))
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
  /** `waitMs`: how long work at the root may wait for transactions open on
   * this test before it is taken for a lost async context (endTestGraceMs). */
  constructor(readonly waitMs = DEFAULT_END_TEST_GRACE_MS) {}

  readonly active = new AsyncLocalStorage<TxNode>()
  readonly root: TxNode = { real: null, tail: Promise.resolve(), failed: false }
  /** Set when endTest() begins: from then on nothing may reach the connection
   * (after the test transaction ends, postgres.js would autocommit it). */
  ended = false
  /** Set once the test transaction is rolled back: not even the savepoint
   * machinery may run (while draining, it still rolls savepoints back). */
  closed = false
  /** Raw savepoints/transactions in progress (raw.savepoint(cb), raw.begin(cb)):
   * endTest waits for them like app transactions. */
  readonly rawOpen = new Set<Promise<unknown>>()

  track(work: Promise<unknown>): void {
    const settled = work.then(
      () => {},
      () => {},
    )
    this.rawOpen.add(settled)
    void settled.then(() => this.rawOpen.delete(settled))
  }

  endedError(): Error {
    return endedError()
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
    return this.waitTurn(n).then(go)
  }

  /** The node's queue — bounded at the root. Work outside every transaction
   * waits for the open ones; if it was meant to run inside one but lost the
   * async context (a worker, a queue, an emitter set up elsewhere), that open
   * transaction is waiting for it, and the wait would never end. */
  waitTurn(node: TxNode): Promise<unknown> {
    if (node !== this.root) return node.tail
    let timer: ReturnType<typeof setTimeout> | undefined
    return Promise.race([
      node.tail.finally(() => clearTimeout(timer)),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `feather-testing-postgres: a query waited ${this.waitMs} ms for a transaction still open in this test — ` +
                  'was it issued outside that transaction’s callback (async context lost?). Run it inside the transaction ' +
                  '(use its tx, or keep the async context, e.g. no worker/queue/emitter set up elsewhere), or await the transaction first.',
              ),
            ),
          this.waitMs,
        )
      }),
    ])
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
    Promise.all([sched.root.tail, ...sched.rawOpen]).then(() => true),
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
const DEFAULT_CLONE_POOL_MAX = 10

// ---------------------------------------------------------------------------
// raw: a frozen facade of our own. No driver object is ever reachable from it:
// the driver sits behind a private port, held only in closures.

type Row = Record<string, unknown>

/** The test's raw SQL handle. Same API on every engine; every method checks
 * that the test is still open, returns plain data, and hands callbacks
 * another RawSql — never a driver object. */
export interface RawSql {
  <T = Row>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>
  unsafe<T = Row>(text: string, params?: unknown[]): Promise<T[]>
  /** A SAVEPOINT in the test's transaction (a real transaction on a `clone`
   * database): kept if fn resolves, rolled back if it throws. */
  savepoint<T>(fn: (raw: RawSql) => T | Promise<T>): Promise<T>
  /** Same as savepoint: inside a test, the transaction is already open. */
  begin<T>(fn: (raw: RawSql) => T | Promise<T>): Promise<T>
}

/** How a facade reaches a driver (internal, never exposed). */
interface RawPort {
  query(text: string, params: unknown[]): Promise<Row[]>
  /** Pool-like ports (a clone's pool or PGlite instance) open a real transaction. */
  begin?<T>(fn: (port: RawPort) => Promise<T>): Promise<T>
}

/** What a facade checks: new work refused once ended; savepoint cleanup
 * allowed until closed. */
interface RawGate extends QueryGate {
  readonly closed: boolean
}

const plainRows = (rows: Iterable<unknown>): Row[] => Array.from(rows, (r) => ({ ...(r as Row) }))

function taggedPort(handle: any, driver: PostgresDriver, pool: boolean): RawPort {
  return {
    query: async (text, params) => plainRows(await handle.unsafe(text, params)),
    begin: pool ? (fn) => handle.begin((h: any) => fn(taggedPort(h, driver, false))) : undefined,
  }
}

function pglitePort(handle: any, instance: boolean): RawPort {
  return {
    query: async (text, params) => plainRows((await handle.query(text, params)).rows),
    begin: instance ? (fn) => handle.transaction((tx: any) => fn(pglitePort(tx, false))) : undefined,
  }
}

/** A clone's gate: refuses new work once the test ended, and tracks what is in
 * flight so endTest can let it finish (bounded) before closing the clone. */
class CloneGate implements RawGate {
  ended = false
  closed = false
  readonly inflight = new Set<Promise<unknown>>()

  check(): void {
    if (this.ended) throw endedError()
  }

  track(work: Promise<unknown>): void {
    const settled = work.then(
      () => {},
      () => {},
    )
    this.inflight.add(settled)
    void settled.then(() => this.inflight.delete(settled))
  }

  query<T>(fn: () => T | PromiseLike<T>): Promise<T> {
    const work = (async () => {
      this.check()
      return fn()
    })()
    this.track(work)
    return work
  }
}

/** Resolves true if all of `work` settles within `ms`, false otherwise. */
async function settledWithin(work: Promise<unknown>[], ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const result = await Promise.race([
    Promise.all(work.map((w) => w.then(() => {}, () => {}))).then(() => true),
    new Promise<boolean>((r) => {
      timer = setTimeout(() => r(false), ms)
    }),
  ])
  clearTimeout(timer)
  return result
}

function clientHiddenError(): Error {
  return new Error('feather-testing-postgres: db.$client is not available in tests: use db, sql or raw')
}

/** A clone's drizzle db (and its transactions) with $client hidden, as under
 * tx. Drizzle never reads $client itself — it runs on its own session. */
function hideClient(db: any): any {
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

function cancelledError(): Error {
  return new Error('feather-testing-postgres: transaction cancelled — its parent transaction failed before it started')
}

function endedError(): Error {
  return new Error(
    "feather-testing-postgres: this test has ended — a query ran after endTest; await your app's work before the test finishes",
  )
}

function rawFacade(port: RawPort, gate: RawGate, inTransaction: boolean, names = { n: 0 }): RawSql {
  // In a test transaction the gate is the test's scheduler: raw queries and
  // savepoints are serialised with db and sql (a write in flight never lands
  // inside — and vanishes with — someone else's savepoint).
  const sched = gate instanceof Scheduler ? gate : undefined
  const run = (text: string, params: unknown[]) => gate.query(() => port.query(text, params))
  const facade = (strings: TemplateStringsArray, ...values: unknown[]) =>
    run(templateToText(strings, values), values)
  const savepoint = async <T>(fn: (raw: RawSql) => T | Promise<T>): Promise<T> => {
    gate.check()
    if (!inTransaction && port.begin) {
      const work = port.begin((p) => Promise.resolve(fn(rawFacade(p, gate, true))))
      gate.track(work)
      return work
    }
    const name = `feather_raw_sp_${++names.n}`
    // savepoint cleanup may run while endTest drains, never once it closed
    const machinery = async (q: string) => {
      if (gate.closed) throw endedError()
      return port.query(q, [])
    }
    const child = () => rawFacade(port, gate, true, names)
    if (sched) {
      // a node in the scheduler, exactly like a db transaction: queued behind
      // its siblings under the innermost open transaction, settling only after
      // its own children, cancelling queued children if it fails
      const parent = sched.active.getStore() ?? sched.root
      const ahead = parent.tail
      const work = sched.waitTurn(parent).then(() => {
        sched.check()
        if (parent.failed) throw cancelledError()
        return sched.active.run(OPENING, async () => {
          await machinery(`savepoint ${name}`)
          // the parent's drizzle handle: a db.transaction() opened inside this
          // raw savepoint nests in it (savepoints stack per connection)
          const self = newNode(parent.real)
          let result: T
          try {
            result = await sched.active.run(self, () => fn(child()))
          } catch (e) {
            self.failed = true
            await self.tail
            await machinery(`rollback to savepoint ${name}`).catch(() => {})
            throw e
          }
          await self.tail
          await machinery(`release savepoint ${name}`)
          return result
        })
      })
      // still after whatever was ahead, even if this one gave up waiting
      parent.tail = Promise.all([ahead, work.catch(() => {})])
      return work
    }
    const work = (async () => {
      await machinery(`savepoint ${name}`)
      try {
        const result = await fn(child())
        await machinery(`release savepoint ${name}`)
        return result
      } catch (e) {
        await machinery(`rollback to savepoint ${name}`).catch(() => {})
        throw e
      }
    })()
    gate.track(work)
    return work
  }
  const methods: Record<string, unknown> = {
    unsafe: (text: string, params: unknown[] = []) => run(text, params),
    savepoint,
    begin: savepoint,
  }
  for (const [k, f] of Object.entries(methods)) Object.defineProperty(facade, k, { value: Object.freeze(f), enumerable: true })
  return Object.freeze(facade) as unknown as RawSql
}

function newNode(real: any): TxNode {
  return { real, tail: Promise.resolve(), failed: false }
}

function serialisingDrizzle(rootDb: any, sched: Scheduler): any {
  const { active } = sched
  delete rootDb.$client // hidden in tests; drizzle uses its own session
  sched.root.real = rootDb
  const wrap = (real: any, own: TxNode): any =>
    new Proxy(real, {
      get(target, prop) {
        if (prop === '$client') throw clientHiddenError()
        if (prop === 'transaction')
          // config (isolation level, access mode, deferrable) is dropped: a
          // SAVEPOINT can't change the test transaction's mode
          return (fn: (tx: unknown) => Promise<unknown>, _config?: unknown) => {
            const parent = active.getStore() ?? own
            if (sched.ended) return Promise.reject(sched.endedError())
            const ahead = parent.tail
            const run = sched.waitTurn(parent).then(() => {
              sched.check()
              if (parent.failed) throw cancelledError()
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
                }),
              )
            })
            // still after whatever was ahead, even if this one gave up waiting
            parent.tail = Promise.all([ahead, run.catch(() => {})])
            return run
          }
        const v = Reflect.get(target, prop)
        return typeof v === 'function' ? v.bind(target) : v
      },
    })
  return wrap(rootDb, sched.root)
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
function taggedClient(root: any, gate: QueryGate, pool: boolean): unknown {
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
function pgliteInstanceClient(pg: any, gate: QueryGate): unknown {
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
function savepointingPgliteTx(tx: any, sched: Scheduler): unknown {
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
  allowAnyDatabase?: boolean
}): Promise<string[]> {
  const url = resolveTestDatabaseUrl(opts)
  const c = await connectPostgres(url, opts.driver ?? defaultDriver(), 1)
  try {
    return await sweep(c.sql, { anyHost: true, olderThan: opts.olderThan })
  } finally {
    await c.close()
  }
}

/** A database name a test run may use: `test` as a word part — app_test,
 * test, test_db, my-test-db, tests — not contest, latest, testing. */
const TEST_DATABASE_NAME = /(^|[^a-z0-9])tests?([^a-z0-9]|$)/i

/** The Postgres URL tests may use, never a non-test database by accident: the
 * `url` option, else FEATHER_DATABASE_URL, else TEST_DATABASE_URL (explicit
 * choices), else DATABASE_URL — only if its database is named like a test
 * database, or with `allowAnyDatabase: true`. Throws otherwise, before any
 * connection is made. */
export function resolveTestDatabaseUrl(
  options: { url?: string; allowAnyDatabase?: boolean } = {},
  env: Record<string, string | undefined> = process.env,
): string {
  const explicit = options.url ?? env.FEATHER_DATABASE_URL ?? env.TEST_DATABASE_URL
  if (explicit) return explicit
  const url = env.DATABASE_URL
  if (!url)
    throw new Error(
      "feather-testing-postgres: engine 'postgres' needs a database: set FEATHER_DATABASE_URL (or TEST_DATABASE_URL, or a test-named DATABASE_URL), or pass `url`",
    )
  if (options.allowAnyDatabase) return url
  let name = ''
  try {
    name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''))
  } catch {
    // unparsable: treated as not a test database
  }
  if (TEST_DATABASE_NAME.test(name)) return url
  throw new Error(
    `feather-testing-postgres: refusing DATABASE_URL database "${name}" — it isn't named like a test database (e.g. app_test). ` +
      'Point FEATHER_DATABASE_URL or TEST_DATABASE_URL at a test database, or pass allowAnyDatabase: true to use this one.',
  )
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
        const drop = () => admin!.sql.unsafe(`drop database if exists "${name}" with (force)`)
        await admin!.sql.unsafe(`create database "${name}" template "${templateName}"`)
        let c: Conn
        try {
          c = await connectPostgres(withDatabase(requireUrl(), name), driver, options.poolMax ?? DEFAULT_CLONE_POOL_MAX)
        } catch (e) {
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
