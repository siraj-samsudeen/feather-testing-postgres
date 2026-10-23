// raw: a frozen facade of our own over the test's connection. No driver object
// is ever reachable from it.

import { OPENING, Scheduler, cancelledError, endedError, newNode, type QueryGate } from './scheduler'
import type { PostgresDriver } from './engine'

export function templateToText(strings: TemplateStringsArray, values: unknown[]): string {
  return strings.reduce((acc, s, i) => acc + (i > 0 ? `$${i}` : '') + s, '')
}

export type Row = Record<string, unknown>

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
export interface RawPort {
  query(text: string, params: unknown[]): Promise<Row[]>
  /** Pool-like ports (a clone's pool or PGlite instance) open a real transaction. */
  begin?<T>(fn: (port: RawPort) => Promise<T>): Promise<T>
}

/** What a facade checks: new work refused once ended; savepoint cleanup
 * allowed until closed. */
export interface RawGate extends QueryGate {
  readonly closed: boolean
}

export const plainRows = (rows: Iterable<unknown>): Row[] => Array.from(rows, (r) => ({ ...(r as Row) }))

export function taggedPort(handle: any, driver: PostgresDriver, pool: boolean): RawPort {
  return {
    query: async (text, params) => plainRows(await handle.unsafe(text, params)),
    begin: pool ? (fn) => handle.begin((h: any) => fn(taggedPort(h, driver, false))) : undefined,
  }
}

export function pglitePort(handle: any, instance: boolean): RawPort {
  return {
    query: async (text, params) => plainRows((await handle.query(text, params)).rows),
    begin: instance ? (fn) => handle.transaction((tx: any) => fn(pglitePort(tx, false))) : undefined,
  }
}

export function rawFacade(port: RawPort, gate: RawGate, inTransaction: boolean, names = { n: 0 }): RawSql {
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
