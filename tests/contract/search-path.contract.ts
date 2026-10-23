// The database check can't be fooled by search_path: a schema earlier on the
// path defining its own current_database() is ignored — the guard calls
// pg_catalog.current_database().
import { assertTestDatabase, createFeatherDb, type PostgresDriver } from '../../src/engine'
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
      for (const driver of drivers)
        test(`end to end: a non-test database behind a shadowing search_path is refused (${driver})`, async () => {
          const admin = await openAdmin()
          const probe = 'shadow_probe'
          const saved = process.env.PGDATABASE
          try {
            await admin.unsafe(`drop database if exists ${probe} with (force)`)
            await admin.unsafe(`create database ${probe}`)
            const inProbe = await openAdmin(probe)
            for (const statement of SHADOW('app')) await inProbe.unsafe(statement)
            await inProbe.close()
            // credentials kept: only the path is cleared, the database comes from PGDATABASE
            const url = new URL(process.env.DATABASE_URL!)
            url.pathname = ''
            url.search = `options=${encodeURIComponent('-c search_path=app,pg_catalog')}`
            process.env.PGDATABASE = probe
            const fdb = createFeatherDb({ driver, url: url.toString(), migrations: MIGRATIONS })
            try {
              await expect(fdb.start()).rejects.toThrow(`"${probe}"`)
            } finally {
              await fdb.close()
            }
          } finally {
            if (saved === undefined) delete process.env.PGDATABASE
            else process.env.PGDATABASE = saved
            await admin.unsafe(`drop database if exists ${probe} with (force)`)
            await admin.close()
          }
        }, 30_000)
    }
  })
}

/** A plain autocommit connection (CREATE/DROP DATABASE), keeping DATABASE_URL's credentials. */
async function openAdmin(database?: string) {
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
