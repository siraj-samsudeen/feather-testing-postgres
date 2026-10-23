// The library's own connections (admin, cleanup, guard) take nothing from the
// URL that changes how SQL resolves, and run no driver startup query that a
// user schema could shadow. A shadowing "char" = operator with a side effect
// (postgres.js's startup type query compares "char" values) must never fire
// through them.
import { cleanupStale, createFeatherDb, type PostgresDriver } from '../../src/engine'
import { ENGINE, MIGRATIONS, type RunnerApi } from './runner'

const SHADOW_CHAR_EQ = [
  'create schema if not exists evil',
  'create table if not exists evil.side_effects (at timestamptz default pg_catalog.now())',
  `create or replace function evil.char_eq("char", "char") returns boolean language plpgsql as $$
     begin insert into evil.side_effects default values; return pg_catalog.chareq($1, $2); end $$`,
  'drop operator if exists evil.= ("char", "char")',
  'create operator evil.= (leftarg = "char", rightarg = "char", function = evil.char_eq)',
]

export function libraryConnectionsContract({ describe, test, expect }: RunnerApi) {
  if (ENGINE !== 'postgres') return
  const drivers: PostgresDriver[] = (globalThis as any).Bun ? ['bun', 'postgres-js'] : ['postgres-js']
  const withParams = (params: Record<string, string>, database?: string) => {
    const u = new URL(process.env.DATABASE_URL!)
    if (database) u.pathname = `/${database}`
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
    return u.toString()
  }

  describe('library-only connections', () => {
    test('sanity: the shadow fires through postgres.js type discovery on an ordinary connection', async () => {
      const admin = await plainConnection()
      try {
        for (const s of SHADOW_CHAR_EQ) await admin.unsafe(s)
        await admin.unsafe('truncate evil.side_effects')
        const postgres = (await import('postgres')).default
        const victim = postgres(withParams({ search_path: 'evil,pg_catalog' }), { max: 1, onnotice: () => {} })
        await victim`select 1`
        await victim.end()
        expect(Number((await admin.unsafe('select count(*) as n from evil.side_effects'))[0].n)).toBeGreaterThan(0)
      } finally {
        await admin.unsafe('drop schema if exists evil cascade')
        await admin.close()
      }
    }, 30_000)

    if ((globalThis as any).Bun)
      test('Bun.sql runs no startup query a shadow could catch (reported)', async () => {
        const admin = await plainConnection()
        try {
          for (const s of SHADOW_CHAR_EQ) await admin.unsafe(s)
          await admin.unsafe('truncate evil.side_effects')
          const victim = new (globalThis as any).Bun.SQL(withParams({ search_path: 'evil,pg_catalog' }), { max: 1 })
          await victim`select 1`
          await victim.close()
          expect(Number((await admin.unsafe('select count(*) as n from evil.side_effects'))[0].n)).toBe(0)
        } finally {
          await admin.unsafe('drop schema if exists evil cascade')
          await admin.close()
        }
      }, 30_000)

    for (const driver of drivers)
      for (const [label, params] of [
        // pg_catalog last: evil's operator wins; the clone template's own
        // migrations (the user's SQL, on a test connection) create in public
        ['?search_path=', { search_path: 'evil,public,pg_catalog' }],
        ['options=-c search_path=', { options: '-c search_path=evil,public,pg_catalog' }],
      ] as const)
        test(`a URL's ${label} can't reach admin, cleanup or guard SQL (${driver})`, async () => {
          const plain = createFeatherDb({ driver, migrations: MIGRATIONS })
          await plain.start() // migrated beforehand, without the shadow
          await plain.close()
          const admin = await plainConnection()
          try {
            for (const s of SHADOW_CHAR_EQ) await admin.unsafe(s)
            await admin.unsafe('truncate evil.side_effects')
            const url = withParams(params)
            await cleanupStale({ olderThan: 3600_000, url, driver })
            // clone: every connection to the target database is the library's
            // (admin, guard); the test pools are on the clone databases
            const fdb = createFeatherDb({ driver, strategy: 'clone', url, migrations: MIGRATIONS })
            try {
              await fdb.beginTest()
              await fdb.endTest()
            } finally {
              await fdb.close()
            }
            expect(Number((await admin.unsafe('select count(*) as n from evil.side_effects'))[0].n)).toBe(0)
          } finally {
            await admin.unsafe('drop schema if exists evil cascade')
            await admin.close()
          }
        }, 60_000)

    for (const driver of drivers)
      test(`a non-test database is refused before any connection runs SQL there (${driver})`, async () => {
        const admin = await plainConnection()
        const nontest = 'shadow_nontest'
        try {
          await admin.unsafe(`drop database if exists ${nontest} with (force)`)
          await admin.unsafe(`create database ${nontest}`)
          const inside = await plainConnection(nontest)
          for (const s of SHADOW_CHAR_EQ) await inside.unsafe(s)
          await inside.unsafe(`alter database ${nontest} set search_path = evil, pg_catalog`)
          for (const strategy of ['tx', 'clone'] as const) {
            const fdb = createFeatherDb({ driver, strategy, url: withParams({}, nontest), migrations: MIGRATIONS })
            try {
              await expect(fdb.start()).rejects.toThrow(`"${nontest}"`)
            } finally {
              await fdb.close()
            }
          }
          expect(Number((await inside.unsafe('select count(*) as n from evil.side_effects'))[0].n)).toBe(0)
          await inside.close()
        } finally {
          await admin.unsafe(`drop database if exists ${nontest} with (force)`)
          await admin.close()
        }
      }, 60_000)

    for (const driver of drivers)
      for (const strategy of ['tx', 'clone'] as const)
        test(`test connections keep the URL's search_path parameter (${driver}, ${strategy})`, async () => {
          const fdb = createFeatherDb({ driver, strategy, url: withParams({ search_path: 'app_schema,public' }), migrations: MIGRATIONS })
          try {
            const t = await fdb.beginTest()
            const [{ search_path }] = await t.sql<{ search_path: string }>`show search_path`
            expect(search_path.replace(/\s/g, '')).toBe('app_schema,public')
            await fdb.endTest()
          } finally {
            await fdb.close()
          }
        }, 30_000)
  })
}

/** An ordinary autocommit connection with DATABASE_URL's credentials. */
async function plainConnection(database?: string) {
  const url = new URL(process.env.DATABASE_URL!)
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
