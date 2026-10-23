// The per-test scheduler (tx): which transaction a query belongs to, what
// waits for what, and how a test ends; plus a clone test's gate.

import { AsyncLocalStorage } from 'node:async_hooks'
import type { RawGate } from './raw'

/** Where a test's queries are admitted: the tx scheduler or a clone's gate.
 * Both refuse once the test ended and know what is still in flight. */
export interface QueryGate {
  check(): void
  query<T>(fn: () => T | PromiseLike<T>): Promise<T>
  track(work: Promise<unknown>): void
}

/** One node per open transaction (the root is the test itself). */
export interface TxNode {
  real: any
  /** Work queued under this node: its child transactions, in order. */
  tail: Promise<unknown>
  /** Set once the node's own callback has failed: children not yet started
   * are cancelled rather than run inside a savepoint about to roll back. */
  failed: boolean
  /** The transaction machinery's own SQL (SAVEPOINT / RELEASE / ROLLBACK TO). */
  passthrough?: boolean
}

export const OPENING: TxNode = { real: null, tail: Promise.resolve(), failed: false, passthrough: true }

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
export class Scheduler {
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
export async function endHeld(
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

export const DEFAULT_END_TEST_GRACE_MS = 2000

/** A clone's gate: refuses new work once the test ended, and tracks what is in
 * flight so endTest can let it finish (bounded) before closing the clone. */
export class CloneGate implements RawGate {
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
export async function settledWithin(work: Promise<unknown>[], ms: number): Promise<boolean> {
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

export function clientHiddenError(): Error {
  return new Error('feather-testing-postgres: db.$client is not available in tests: use db, sql or raw')
}

export function cancelledError(): Error {
  return new Error('feather-testing-postgres: transaction cancelled — its parent transaction failed before it started')
}

export function endedError(): Error {
  return new Error(
    "feather-testing-postgres: this test has ended — a query ran after endTest; await your app's work before the test finishes",
  )
}

export function newNode(real: any): TxNode {
  return { real, tail: Promise.resolve(), failed: false }
}

export function serialisingDrizzle(rootDb: any, sched: Scheduler): any {
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
