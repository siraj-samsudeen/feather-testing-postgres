// A Unix-socket URL: the guard (a library-only connection) and the tests reach
// the same server. Bun.sql takes the socket as ?path=; postgres.js from an
// empty URL host and PGHOST. Uses the local server's socket directory.
import { createFeatherDb } from '../../src/engine'
import { ENGINE, MIGRATIONS, type RunnerApi } from './runner'

const SOCKET_DIR = process.env.FEATHER_TEST_SOCKET_DIR ?? '/tmp'

export function socketContract({ describe, test, expect }: RunnerApi) {
  if (ENGINE !== 'postgres') return
  const { existsSync } = require('node:fs') as typeof import('node:fs')
  const base = new URL(process.env.DATABASE_URL!)
  const port = base.port || '5432'
  if (!existsSync(`${SOCKET_DIR}/.s.PGSQL.${port}`)) return
  const database = base.pathname.slice(1)

  describe('Unix-socket URLs', () => {
    const variants: Array<[string, 'bun' | 'postgres-js', () => string, Record<string, string>]> = []
    if ((globalThis as any).Bun) {
      const u = new URL(base)
      // the socket file (Bun.sql takes a directory only when the URL has no port)
      u.searchParams.set('path', `${SOCKET_DIR}/.s.PGSQL.${port}`)
      variants.push(['bun ?path=', 'bun', () => u.toString(), {}])
    }
    // postgres.js: no host in the URL, the socket directory from PGHOST
    variants.push(['postgres.js empty host + PGHOST', 'postgres-js', () => `postgres:///${database}`, { PGHOST: SOCKET_DIR, PGPORT: port }])
    for (const [label, driver, makeUrl, env] of variants)
      for (const strategy of ['tx', 'clone'] as const)
        test(`${label}: the guard and the tests use the socket (${strategy})`, async () => {
          const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]))
          Object.assign(process.env, env)
          try {
            const fdb = createFeatherDb({ driver, strategy, url: makeUrl(), migrations: MIGRATIONS })
            try {
              const t = await fdb.beginTest()
              const [{ addr }] = await t.sql<{ addr: string | null }>`select pg_catalog.inet_server_addr()::text as addr`
              expect(addr).toBeNull() // a Unix-socket connection
              await fdb.endTest()
            } finally {
              await fdb.close()
            }
          } finally {
            for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]
            else process.env[k] = v
          }
        }, 30_000)
  })
}
