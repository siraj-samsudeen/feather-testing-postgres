// feather-testing-postgres/drizzle — test-data factories typed from a Drizzle
// table (drizzle-orm is an optional peer; only this entry needs it).
//
//   const userFactory = factory(users, { email: seq((n) => `u${n}@x.test`), name: 'Ada' })
//   const u = await userFactory.insert(db, { name: 'Grace' })   // typed $inferSelect

import type { PgDatabase, PgQueryResultHKT, PgTable } from 'drizzle-orm/pg-core'

/** A Drizzle Postgres database (or transaction) as handed out by beginTest(). */
export type FeatherDrizzleDb<TSchema extends Record<string, unknown> = Record<string, never>> =
  PgDatabase<PgQueryResultHKT, TSchema>

const SEQ = Symbol('feather.seq')

/** A default computed from a per-factory counter (1, 2, 3, ...), for unique
 * columns. Counters never reset, so values stay unique across rolled-back tests
 * within a process. */
export interface Sequence<T> {
  readonly [SEQ]: (n: number) => T
}

export function seq<T>(fn: (n: number) => T): Sequence<T> {
  return { [SEQ]: fn }
}

export type Defaults<I> = { [K in keyof I]?: I[K] | Sequence<I[K]> }

/** What insert()/build() still need: every required column the defaults don't
 * cover, plus any column as an optional override. */
export type Overrides<I, D> = Omit<I, keyof D> & Partial<I>

type OverrideArgs<I, D> = {} extends Overrides<I, D> ? [overrides?: Overrides<I, D>] : [overrides: Overrides<I, D>]

export interface Factory<T extends PgTable, D> {
  readonly table: T
  /** The row insert() would write, without touching the database. */
  build(...args: OverrideArgs<T['$inferInsert'], D>): T['$inferInsert']
  /** Inserts one row and returns it as selected (defaults applied by the DB too). */
  insert(db: PgDatabase<any, any, any>, ...args: OverrideArgs<T['$inferInsert'], D>): Promise<T['$inferSelect']>
  /** Inserts `count` rows; overrides may depend on the index. */
  insertMany(
    db: PgDatabase<any, any, any>,
    count: number,
    overrides?: Overrides<T['$inferInsert'], D> | ((i: number) => Overrides<T['$inferInsert'], D>),
  ): Promise<T['$inferSelect'][]>
}

export function factory<T extends PgTable, const D extends Defaults<T['$inferInsert']>>(
  table: T,
  defaults: D,
): Factory<T, D> {
  let n = 0
  const build = (overrides: object = {}) => {
    const k = ++n
    const row: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(defaults))
      row[key] = v && typeof v === 'object' && SEQ in v ? (v as Sequence<unknown>)[SEQ](k) : v
    return { ...row, ...overrides } as T['$inferInsert']
  }
  return {
    table,
    build: ((o?: object) => build(o)) as Factory<T, D>['build'],
    insert: (async (db: PgDatabase<any, any, any>, o?: object) => {
      const [row] = await db.insert(table).values(build(o)).returning()
      return row
    }) as Factory<T, D>['insert'],
    async insertMany(db, count, overrides) {
      if (count <= 0) return []
      const rows = Array.from({ length: count }, (_, i) =>
        build(typeof overrides === 'function' ? overrides(i) : overrides),
      )
      return (await db.insert(table).values(rows).returning()) as T['$inferSelect'][]
    },
  }
}
