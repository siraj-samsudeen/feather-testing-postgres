// The real check: after connecting, the server's current_database() must be a
// test database (target, admin) or exactly the database we created (template,
// clone). This catches what URL parsing can't: an empty path resolved through
// PGDATABASE or the user name, and drivers that let the environment win.
import { createFeatherDb, type IsolationStrategy, type PostgresDriver } from '../../src/engine'
import { ENGINE, MIGRATIONS, type RunnerApi } from './runner'

export function currentDatabaseContract({ describe, test, expect }: RunnerApi) {
  if (ENGINE !== 'postgres') return
  const drivers: PostgresDriver[] = (globalThis as any).Bun ? ['bun', 'postgres-js'] : ['postgres-js']
  const base = new URL(process.env.DATABASE_URL!)
  const testDb = base.pathname.slice(1)
  // the same URL — credentials, host, parameters — with only the path changed
  const withPath = (path: string) => {
    const u = new URL(base)
    u.pathname = path
    return u.toString()
  }
  const server = withPath('')

  async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
    for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k]
    else process.env[k] = v
    try {
      return await fn()
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }

  describe('current_database() is checked after connecting', () => {
    for (const driver of drivers)
      for (const strategy of ['tx', 'clone'] as IsolationStrategy[]) {
        const label = `${driver}, ${strategy}`

        test(`an empty path resolved by PGDATABASE to a non-test database is refused (${label})`, async () => {
          await withEnv({ PGDATABASE: 'postgres' }, async () => {
            const fdb = createFeatherDb({ driver, strategy, url: server, migrations: MIGRATIONS })
            try {
              await expect(fdb.start()).rejects.toThrow(/"postgres"/)
            } finally {
              await fdb.close()
            }
          })
        }, 30_000)

        test(`an empty path resolved by PGDATABASE to a test database works, and tests run there (${label})`, async () => {
          await withEnv({ PGDATABASE: testDb }, async () => {
            const fdb = createFeatherDb({ driver, strategy, url: server, migrations: MIGRATIONS })
            try {
              const t = await fdb.beginTest()
              const [{ db, user }] = await t.sql<{ db: string; user: string }>`
                select pg_catalog.current_database() as db, current_user as "user"`
              // the URL's credentials were used (CI connects with user:password)
              if (base.username) expect(user).toBe(decodeURIComponent(base.username))
              if (strategy === 'tx') expect(db).toBe(testDb)
              else expect(db).toMatch(/^feather_t_/)
              await fdb.endTest()
            } finally {
              await fdb.close()
            }
          })
        }, 30_000)

        test(`the URL path wins over PGDATABASE (${label})`, async () => {
          await withEnv({ PGDATABASE: 'postgres' }, async () => {
            const fdb = createFeatherDb({ driver, strategy, url: withPath(`/${testDb}`), migrations: MIGRATIONS })
            try {
              const t = await fdb.beginTest()
              const [{ db, user }] = await t.sql<{ db: string; user: string }>`
                select pg_catalog.current_database() as db, current_user as "user"`
              // the URL's credentials were used (CI connects with user:password)
              if (base.username) expect(user).toBe(decodeURIComponent(base.username))
              if (strategy === 'tx') expect(db).toBe(testDb)
              else expect(db).toMatch(/^feather_t_/)
              await fdb.endTest()
            } finally {
              await fdb.close()
            }
          })
        }, 30_000)
      }
  })
}
