// Crashed runs leave feather_tpl_<pid>_* / feather_t_<pid>_* databases behind.
// The postgres engine's start() drops those whose pid is no longer running —
// and nothing else.
import { createFeatherDb, type SqlRunner } from '../../src/engine'
import { ENGINE, type RunnerApi } from './runner'

const DEAD = 99999999 // above any pid_max: never a running process
const names = {
  deadTemplate: `feather_tpl_${DEAD}_crashed`,
  deadClone: `feather_t_${DEAD}_7`,
  deadButConnected: `feather_t_${DEAD}_8`,
  mine: `feather_t_${process.pid}_999999`,
  notOurs: `feather_t_notapid_1`,
}

export function abandonedDatabasesContract({ describe, test, expect }: RunnerApi) {
  if (ENGINE !== 'postgres') return
  describe('abandoned databases from crashed runs', () => {
    test('start() drops dead-pid feather databases only', async () => {
      // create/drop database cannot run inside a test transaction
      const sql = await openAdminSql()
      const exists = async (n: string) =>
        (await sql<{ n: number }>`select count(*)::int as n from pg_database where datname = ${n}`)[0].n === 1
      const holder = createFeatherDb({ url: withDb(names.deadButConnected) })
      try {
        for (const n of Object.values(names)) await sql.unsafe(`create database "${n}"`)
        await holder.beginTest() // an open connection: must survive the sweep

        const fdb = createFeatherDb({})
        await fdb.start()
        await fdb.close()

        expect(await exists(names.deadTemplate)).toBe(false)
        expect(await exists(names.deadClone)).toBe(false)
        expect(await exists(names.deadButConnected)).toBe(true)
        expect(await exists(names.mine)).toBe(true)
        expect(await exists(names.notOurs)).toBe(true)
      } finally {
        await holder.close()
        for (const n of Object.values(names)) await sql.unsafe(`drop database if exists "${n}" with (force)`)
        await closeAdminSql()
      }
    }, 30_000)
  })
}

function withDb(name: string) {
  const u = new URL(process.env.DATABASE_URL!)
  u.pathname = `/${name}`
  return u.toString()
}

// A plain autocommit connection for CREATE/DROP DATABASE.
let adminClient: any
async function openAdminSql(): Promise<SqlRunner> {
  const url = process.env.DATABASE_URL!
  const Bun = (globalThis as any).Bun
  adminClient = Bun?.SQL ? new Bun.SQL(url, { max: 1 }) : (await import('postgres')).default(url, { max: 1, onnotice: () => {} })
  const run = (async (s: TemplateStringsArray, ...v: unknown[]) => Array.from(await adminClient(s, ...v))) as SqlRunner
  run.unsafe = async (text, params) => Array.from(await adminClient.unsafe(text, params ?? []))
  return run
}
async function closeAdminSql() {
  await (adminClient.close ?? adminClient.end).call(adminClient)
}
