// The database check can't be fooled by search_path: a schema earlier on the
// path defining its own current_database() is ignored — the guard calls
// pg_catalog.current_database().
import { assertTestDatabase, cleanupStale, createFeatherDb, type PostgresDriver } from '../../src/engine'
import { ENGINE, MIGRATIONS, type RunnerApi } from './runner'

// one statement each (PGlite's query() takes a single statement)
const SHADOW = (schema: string) => [
  `create schema if not exists ${schema}`,
  `create or replace function ${schema}.current_database() returns name language sql as $$ select 'app_test'::name $$`,
]

export function searchPathContract({ describe, test, expect }: RunnerApi) {
  describe(`search_path can't fake the database check (${ENGINE})`, () => {
    test('a shadowing current_database() earlier on search_path is ignored', async () => {
      const fdb = createFeatherDb({ migrations: MIGRATIONS })
      try {
        const t = await fdb.beginTest()
        const [{ real }] = await t.sql<{ real: string }>`select pg_catalog.current_database() as real`
        for (const statement of SHADOW('shadow_app')) await t.sql.unsafe(statement)
        await t.sql.unsafe('set local search_path = shadow_app, pg_catalog')
        const [{ faked }] = await t.sql<{ faked: string }>`select current_database() as faked`
        expect(faked).toBe('app_test') // the shadow is in effect for unqualified calls
        await assertTestDatabase(t.sql, { expected: real }) // the guard sees the real one
        if (!/(^|[^a-z0-9])tests?([^a-z0-9]|$)/i.test(real))
          await expect(assertTestDatabase(t.sql)).rejects.toThrow(`"${real}"`)
        await fdb.endTest()
      } finally {
        await fdb.close()
      }
    }, 30_000)

    if (ENGINE === 'postgres') {
      const drivers: PostgresDriver[] = (globalThis as any).Bun ? ['bun', 'postgres-js'] : ['postgres-js']
      // DATABASE_URL with a search_path that puts the shadowing schema first
      const shadowedUrl = () => {
        const u = new URL(process.env.DATABASE_URL!)
        // pg_catalog listed last: app's operator/function win; new tables (a
        // fresh clone template's migrations) land in public
        u.searchParams.set('options', '-c search_path=app,public,pg_catalog')
        return u.toString()
      }
      const SHADOW_OPERATOR = [
        'create schema if not exists app',
        'create table if not exists app.side_effects (at timestamptz default pg_catalog.now())',
        `create or replace function app.tilde(name, text) returns boolean language plpgsql as $$
           begin insert into app.side_effects default values; return pg_catalog.nameregexeq($1, $2); end $$`,
        'drop operator if exists app.~ (name, text)',
        'create operator app.~ (leftarg = name, rightarg = text, function = app.tilde)',
        ...SHADOW('app'),
      ]

      for (const driver of drivers)
        test(`a shadowing operator and function on search_path can't run or answer for the library (${driver})`, async () => {
          // migrate the test database first, without the shadow: the user's
          // own migrations under a shadowing search_path are their business
          const plain = createFeatherDb({ driver, migrations: MIGRATIONS })
          await plain.start()
          await plain.close()
          const admin = await openAdmin()
          try {
            for (const statement of SHADOW_OPERATOR) await admin.unsafe(statement)
            const sideEffects = async () => Number((await admin.unsafe('select count(*) as n from app.side_effects'))[0].n)
            expect(await sideEffects()).toBe(0)
            // the shadow is live for anyone whose search_path finds it first
            const viaShadow = await openAdmin(undefined, shadowedUrl())
            expect((await viaShadow.unsafe("select 'feather_t_x'::name ~ 'x' as hit"))[0].hit).toBe(true)
            expect(await sideEffects()).toBe(1)
            await viaShadow.close()
            await admin.unsafe('truncate app.side_effects')

            await cleanupStale({ olderThan: 3600_000, url: shadowedUrl(), driver })
            for (const strategy of ['tx', 'clone'] as const) {
              const fdb = createFeatherDb({ driver, strategy, url: shadowedUrl(), migrations: MIGRATIONS })
              try {
                await fdb.start()
                const t = await fdb.beginTest()
                const [{ db }] = await t.sql<{ db: string }>`select pg_catalog.current_database() as db`
                if (strategy === 'clone') expect(db).toMatch(/^feather_t_/) // the identity check saw the real name
                await fdb.endTest()
              } finally {
                await fdb.close()
              }
            }
            expect(await sideEffects()).toBe(0)
          } finally {
            await admin.unsafe('drop schema if exists app cascade')
            await admin.close()
          }
        }, 60_000)

      for (const driver of drivers)
        for (const strategy of ['tx', 'clone'] as const)
          test(`the pinned search_path never reaches the test: it sees its own (${driver}, ${strategy})`, async () => {
            const u = new URL(process.env.DATABASE_URL!)
            u.searchParams.set('options', '-c search_path=app_schema,public')
            const fdb = createFeatherDb({ driver, strategy, url: u.toString(), migrations: MIGRATIONS })
            try {
              const t = await fdb.beginTest()
              const [{ search_path }] = await t.sql<{ search_path: string }>`show search_path`
              expect(search_path.replace(/\s/g, '')).toBe('app_schema,public')
              const [{ search_path: inRaw }] = await t.raw<{ search_path: string }>`show search_path`
              expect(inRaw.replace(/\s/g, '')).toBe('app_schema,public')
              await fdb.endTest()
            } finally {
              await fdb.close()
            }
          }, 30_000)
    }
  })
}

/** A plain autocommit connection (CREATE/DROP DATABASE), keeping DATABASE_URL's credentials. */
async function openAdmin(database?: string, from = process.env.DATABASE_URL!) {
  const url = new URL(from)
  if (database) url.pathname = `/${database}`
  const Bun = (globalThis as any).Bun
  const client = Bun?.SQL
    ? new Bun.SQL(url.toString(), { max: 1, database: url.pathname.slice(1) })
    : (await import('postgres')).default(url.toString(), { max: 1, onnotice: () => {} })
  return {
    unsafe: (text: string) => client.unsafe(text),
    close: () => (client.close ?? client.end).call(client),
  }
}
