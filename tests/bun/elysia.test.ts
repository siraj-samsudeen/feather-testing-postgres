// The injection contract, end to end: the app takes its db (`createApp({ db })`)
// and the test hands it the Drizzle handle bound to the test's transaction.
// No global delegate, no SQL proxy. This is the README's Elysia example.
import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { asc } from 'drizzle-orm'
import { postgresFixtures, useBunFixtures } from '../../src/bun'
import { factory, seq, type FeatherDrizzleDb } from '../../src/drizzle'
import { todos, users } from '../fixtures/schema'
import { MIGRATIONS } from '../contract/runner'

// --- the app under test (would live in src/app.ts) ---
function createApp({ db }: { db: FeatherDrizzleDb }) {
  return new Elysia()
    .get('/todos', async () => (await db.select().from(todos).orderBy(asc(todos.id))).map((t) => t.title))
    .post('/todos', async ({ body }) => {
      // the app's own transaction: a SAVEPOINT inside the test's transaction
      await db.transaction(async (tx) => {
        await tx.insert(todos).values({ title: (body as { title: string }).title })
      })
      return { ok: true }
    })
}

const userFactory = factory(users, { email: seq((n) => `u${n}@x.test`), name: 'U' })

describe('Elysia app with an injected db', () => {
  const t = useBunFixtures({
    ...postgresFixtures({ migrations: MIGRATIONS }),
    app: { scope: 'test', deps: ['db'], setup: ({ db }: { db: FeatherDrizzleDb }) => createApp({ db }) },
  })

  test('app.handle() sees the fixture rows and its own writes', async () => {
    const u = await userFactory.insert(t.db)
    await t.db.insert(todos).values({ title: 'fixture row', ownerId: u.id })
    const post = await t.app.handle(
      new Request('http://localhost/todos', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'from the app' }),
      }),
    )
    expect(post.status).toBe(200)
    const res = await t.app.handle(new Request('http://localhost/todos'))
    expect(await res.json()).toEqual(['fixture row', 'from the app'])
  })

  test('...and none of it survives', async () => {
    const res = await t.app.handle(new Request('http://localhost/todos'))
    expect(await res.json()).toEqual([])
  })

  test('a listening server (what a browser test drives) shares the transaction', async () => {
    await t.db.insert(todos).values({ title: 'seen over HTTP' })
    const server = t.app.listen(0)
    try {
      const base = `http://localhost:${server.server!.port}`
      // parallel requests queue on the test's single transaction
      const all = await Promise.all([1, 2, 3, 4].map(() => fetch(`${base}/todos`).then((r) => r.json())))
      expect(all).toEqual(Array(4).fill(['seen over HTTP']))
    } finally {
      await server.stop()
    }
  })
})
