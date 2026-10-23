// @vitest-environment node
// createDbTest(): the engines as Vitest `test.extend` fixtures — a test names
// what it needs, and only that is set up.
import { describe, expect } from 'vitest'
import { count } from 'drizzle-orm'
import { createDbTest } from '../../src/vitest'
import { users } from '../fixtures/schema'
import { MIGRATIONS } from '../contract/runner'

const test = createDbTest({ migrations: MIGRATIONS })

describe('createDbTest()', () => {
  test('db is bound to the test transaction', async ({ db, sql }) => {
    await db.insert(users).values({ email: 'a@x.test', name: 'A' })
    const [{ n }] = await sql<{ n: number }>`select count(*)::int as n from users`
    expect(n).toBe(1)
  })

  test('...rolled back before the next test', async ({ db }) => {
    const [{ n }] = await db.select({ n: count() }).from(users)
    expect(n).toBe(0)
  })

  test('a test that names no fixture opens no transaction', async ({ dbEngine }) => {
    expect(dbEngine.engine).toBe(process.env.FEATHER_DB ?? 'pglite')
  })
})
