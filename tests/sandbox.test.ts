// @vitest-environment node
//
// The sandbox against a REAL Postgres: every test below runs inside a
// transaction that is rolled back, driving a miniature app through the same
// createPgTest fixtures a consumer gets. It also exercises the delegating-sql
// seam exactly as the README documents it, so the documented integration is
// covered rather than merely described.
//
// Point it at a throwaway database:
//   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/feather_harness_test

import postgres from 'postgres'
import { describe, expect, beforeAll, afterAll } from 'vitest'
import { createPgTest, withSandbox, TestApiError, type AppLike } from '../src/index'

const url =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@127.0.0.1:5432/feather_harness_test'

const root = postgres(url, { max: 2 })

let delegate: typeof root = root
function setDelegate(tx: unknown | null) {
  delegate = (tx as typeof root) ?? root
}

// The seam from the README, verbatim in shape.
const sql = new Proxy((() => {}) as unknown as typeof root, {
  apply: (_t, _this, args) => (delegate as unknown as (...a: unknown[]) => unknown)(...args),
  get(_t, prop) {
    if (delegate !== root) {
      if (prop === 'begin')
        return (first: unknown, second?: unknown) => {
          const fn = (typeof first === 'function' ? first : second) as (s: unknown) => unknown
          return (delegate as unknown as { savepoint: (f: typeof fn) => unknown }).savepoint(fn)
        }
      if (prop === 'end') return async () => {}
    }
    const v = (delegate as never)[prop] as unknown
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(delegate) : v
  },
})

// A miniature "app": two routes over one table, dispatched in process.
const app: AppLike = {
  async request(input, init) {
    const [path] = input.split('?')
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })

    if (path === '/api/rows') {
      const rows = await sql`select row_id, title from harness_row order by row_id`
      return json({ rows })
    }
    if (path === '/api/save_row') {
      if (!auth) return json({ error: { type: 'AuthError', message: 'sign in first' } }, 401)
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        table: string
        row: Record<string, unknown>
      }
      // Nested app transaction: a real BEGIN here would commit the sandbox, so
      // the seam turns it into a SAVEPOINT.
      const [saved] = await sql.begin(async (tx) => {
        const t = tx as unknown as typeof root
        return t`insert into harness_row (title) values (${String(body.row.title ?? '')}) returning row_id, title`
      })
      return json(saved)
    }
    return json({ error: { type: 'NotFound', message: path } }, 404)
  },
}

let teardowns = 0

const test = createPgTest(
  {
    app,
    sql,
    setDelegate,
    onTeardown: () => {
      teardowns++
    },
    mintToken: async (user) => `token-for-${user}`,
    insertUser: async ({ email, roles }) => {
      const [row] = await sql`
        insert into harness_user (row_id, roles) values (${email}, ${roles.join(',')})
        returning row_id`
      return String(row.row_id)
    },
  },
  { defaultRoles: ['All'] },
)

beforeAll(async () => {
  await root`drop table if exists harness_row`
  await root`drop table if exists harness_user`
  await root`create table harness_row (row_id bigserial primary key, title text not null)`
  await root`create table harness_user (row_id text primary key, roles text not null)`
})

afterAll(async () => {
  await root`drop table if exists harness_row`
  await root`drop table if exists harness_user`
  await root.end()
})

describe('withSandbox', () => {
  test('rolls back writes made directly through the delegate', async ({ db }) => {
    const tx = db as unknown as typeof root
    await tx`insert into harness_row (title) values ('written directly')`
    const rows = await tx`select count(*)::int as n from harness_row`
    expect(rows[0].n).toBe(1)
  })

  test('the next test sees none of it', async ({ db }) => {
    const tx = db as unknown as typeof root
    const rows = await tx`select count(*)::int as n from harness_row`
    expect(rows[0].n).toBe(0)
  })

  test('runs onTeardown after every sandbox', async () => {
    expect(teardowns).toBeGreaterThan(0)
  })

  test('re-throws the body’s failure after rolling back', async () => {
    const before = teardowns
    await expect(
      withSandbox({ sql, setDelegate, onTeardown: () => { teardowns++ } }, async () => {
        throw new Error('body exploded')
      }),
    ).rejects.toThrow('body exploded')
    expect(teardowns).toBe(before + 1)
    const [{ n }] = await root`select count(*)::int as n from harness_row`
    expect(n).toBe(0)
  })
})

describe('createPgTest fixtures', () => {
  test('seed() saves through the app and returns the row id', async ({ seed, admin }) => {
    const row = await seed('Harness Row', { title: 'from seed' })
    expect(row.row_id).toBeTruthy()
    const { rows } = await admin.get<{ rows: { title: string }[] }>('/api/rows')
    expect(rows.map((r) => r.title)).toEqual(['from seed'])
  })

  test('seeded rows do not survive into the next test', async ({ admin }) => {
    const { rows } = await admin.get<{ rows: unknown[] }>('/api/rows')
    expect(rows).toEqual([])
  })

  test('an app transaction inside the sandbox becomes a savepoint', async ({ seed, db }) => {
    // seed() goes through the app's sql.begin; if that had been a real BEGIN
    // the sandbox transaction would have committed and this count would leak.
    await seed('Harness Row', { title: 'savepointed' })
    const tx = db as unknown as typeof root
    const [{ n }] = await tx`select count(*)::int as n from harness_row`
    expect(n).toBe(1)
  })

  test('the anonymous client is rejected, and the error carries the status', async ({ api }) => {
    await expect(api.post('/api/save_row', { table: 'Harness Row', row: {} })).rejects.toMatchObject(
      { status: 401, type: 'AuthError' },
    )
    await expect(api.post('/api/save_row', {})).rejects.toBeInstanceOf(TestApiError)
  })

  test('admin and client are authenticated as different users', async ({ admin, client }) => {
    expect(admin.user).toBe('Administrator')
    expect(admin.token).toBe('token-for-Administrator')
    expect(client.user).toMatch(/@feather\.test$/)
    expect(client.token).toBe(`token-for-${client.user}`)
  })

  test('createUser() makes another authenticated client', async ({ createUser }) => {
    const other = await createUser({ email: 'someone@feather.test', roles: ['Auditor'] })
    expect(other.user).toBe('someone@feather.test')
    const [row] = await root`select 1 from harness_user where row_id = 'someone@feather.test'`
    // ...and it rolled into the sandbox, not the database
    expect(row).toBeUndefined()
  })
})
