// Crashed runs leave feather_tpl_<pid>_* / feather_t_<pid>_* databases behind.
// The postgres engine's start() drops those whose pid is no longer running —
// and nothing else.
import { createHash } from 'node:crypto'
import { hostname } from 'node:os'
import { cleanupStale, createFeatherDb, type SqlRunner } from '../../src/engine'
import { ENGINE, type RunnerApi } from './runner'

const DEAD = 99999999 // above any pid_max: never a running process
const HOST = createHash('sha1').update(hostname()).digest('hex').slice(0, 8)
const OTHER_HOST = HOST === 'deadbeef' ? 'cafef00d' : 'deadbeef'
const OLD = (Date.now() - 2 * 3600_000).toString(36)
const YOUNG = Date.now().toString(36)
const names = {
  ownDeadOld: `feather_t_${HOST}_${DEAD}_${OLD}_1`,
  ownDeadOldTemplate: `feather_tpl_${HOST}_${DEAD}_${OLD}_abc123`,
  ownDeadYoung: `feather_tpl_${HOST}_${DEAD}_${YOUNG}_abc123`,
  ownLiveOld: `feather_t_${HOST}_${process.ppid}_${OLD}_1`,
  ownDeadOldConnected: `feather_t_${HOST}_${DEAD}_${OLD}_2`,
  otherHostDeadOld: `feather_tpl_${OTHER_HOST}_${DEAD}_${OLD}_abc123`,
  otherHostYoung: `feather_t_${OTHER_HOST}_${DEAD}_${YOUNG}_1`,
  notOurs: `feather_t_notapid_1`,
}

export function abandonedDatabasesContract({ describe, test, expect }: RunnerApi) {
  if (ENGINE !== 'postgres') return
  describe('abandoned databases from crashed runs', () => {
    test('start() drops only this host’s dead-pid databases older than an hour; cleanupStale() the rest', async () => {
      // create/drop database cannot run inside a test transaction
      const sql = await openAdminSql()
      const exists = async (n: string) =>
        (await sql<{ n: number }>`select count(*)::int as n from pg_database where datname = ${n}`)[0].n === 1
      const holder = createFeatherDb({ url: withDb(names.ownDeadOldConnected) })
      try {
        for (const n of Object.values(names)) await sql.unsafe(`create database "${n}"`)
        await holder.beginTest() // an open connection: must survive every sweep

        const fdb = createFeatherDb({})
        await fdb.start()
        await fdb.close()

        expect(await exists(names.ownDeadOld)).toBe(false)
        expect(await exists(names.ownDeadOldTemplate)).toBe(false)
        for (const kept of ['ownDeadYoung', 'ownLiveOld', 'ownDeadOldConnected', 'otherHostDeadOld', 'otherHostYoung', 'notOurs'] as const)
          expect([kept, await exists(names[kept])]).toEqual([kept, true])

        // opt-in, for leftovers of other hosts: any host, still never a live
        // pid on this host, never forced, never younger than olderThan
        const dropped = await cleanupStale({ olderThan: 3600_000 })
        expect(dropped).toEqual([names.otherHostDeadOld])
        for (const kept of ['ownDeadYoung', 'ownLiveOld', 'ownDeadOldConnected', 'otherHostYoung', 'notOurs'] as const)
          expect([kept, await exists(names[kept])]).toEqual([kept, true])
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
