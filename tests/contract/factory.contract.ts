// feather-testing-postgres/drizzle: factory(table, defaults) → insert(db, overrides)
import { factory, seq } from '../../src/drizzle'
import { postgresFixtures, useFixtures } from '../../src/fixtures'
import { todos, users } from '../fixtures/schema'
import { ENGINE, MIGRATIONS, type RunnerApi } from './runner'

const userFactory = factory(users, {
  email: seq((n) => `user${n}@x.test`),
  name: 'Test User',
})
// no default for title: insert() requires it in the overrides (a type error otherwise)
const todoFactory = factory(todos, { done: false })

export function factoryContract({ describe, test, expect, beforeAll, afterAll, beforeEach, afterEach }: RunnerApi) {
  describe(`drizzle factory (${ENGINE})`, () => {
    const t = useFixtures(postgresFixtures({ migrations: MIGRATIONS }), { beforeAll, afterAll, beforeEach, afterEach })

    test('insert() writes the defaults and returns the selected row', async () => {
      const u = await userFactory.insert(t.db)
      expect(u.id).toBeGreaterThan(0)
      expect(u.name).toBe('Test User')
      expect(u.email).toMatch(/^user\d+@x\.test$/)
    })

    test('sequences keep unique columns unique', async () => {
      const [a, b] = [await userFactory.insert(t.db), await userFactory.insert(t.db)]
      expect(a.email).not.toBe(b.email)
    })

    test('overrides win, and a required column without a default comes from them', async () => {
      const u = await userFactory.insert(t.db, { name: 'Ada' })
      const todo = await todoFactory.insert(t.db, { title: 'write tests', ownerId: u.id })
      expect(u.name).toBe('Ada')
      expect(todo).toMatchObject({ title: 'write tests', ownerId: u.id, done: false })
      expect(todo.createdAt).toBeInstanceOf(Date)
    })

    test('insertMany() and build()', async () => {
      const many = await userFactory.insertMany(t.db, 3, (i) => ({ name: `N${i}` }))
      expect(many.map((u) => u.name)).toEqual(['N0', 'N1', 'N2'])
      const built = userFactory.build({ name: 'Built' })
      expect(built).toMatchObject({ name: 'Built' })
      expect(typeof built.email).toBe('string')
    })

    test('factory rows roll back with the test', async () => {
      const rows = await t.sql<{ n: number }>`select count(*)::int as n from users`
      expect(rows[0].n).toBe(0)
    })
  })
}

// @ts-expect-error — title has no default, so overrides are required
void (() => todoFactory.insert(null as any))
