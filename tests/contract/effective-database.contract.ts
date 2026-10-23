// Which database a URL means, per driver — the database each driver would
// pick itself, handed to it explicitly. Pure: runs in every lane.
// postgres.js: path, PGDATABASE, then the user: URL user, PGUSERNAME, PGUSER, OS account.
// Bun.sql:     path, PGDATABASE, then the user: URL user, PGUSER, USER, OS account (PGUSERNAME ignored).
import { userInfo } from 'node:os'
import { databaseOf } from '../../src/drivers'
import type { RunnerApi } from './runner'

const empty = 'postgres://localhost:5432'

export function effectiveDatabaseContract({ describe, test, expect }: RunnerApi) {
  describe('the database a URL means, per driver', () => {
    test('the path wins, then PGDATABASE (both drivers)', () => {
      for (const driver of ['postgres-js', 'bun'] as const) {
        expect(databaseOf(`${empty}/app_test`, driver, { PGDATABASE: 'other', PGUSER: 'u' })).toBe('app_test')
        expect(databaseOf(empty, driver, { PGDATABASE: 'env_test', PGUSER: 'u' })).toBe('env_test')
        expect(databaseOf('postgres://alice@localhost:5432', driver, { PGUSER: 'u' })).toBe('alice')
      }
    })

    test('postgres.js: PGUSERNAME, then PGUSER, then the OS account', () => {
      expect(databaseOf(empty, 'postgres-js', { PGUSERNAME: 'a', PGUSER: 'b', USER: 'c' })).toBe('a')
      expect(databaseOf(empty, 'postgres-js', { PGUSER: 'b', USER: 'c' })).toBe('b')
      expect(databaseOf(empty, 'postgres-js', { USER: 'c' })).toBe(userInfo().username)
    })

    test('Bun.sql: PGUSER, then USER, then the OS account; PGUSERNAME is ignored', () => {
      expect(databaseOf(empty, 'bun', { PGUSERNAME: 'a', PGUSER: 'b', USER: 'c' })).toBe('b')
      expect(databaseOf(empty, 'bun', { PGUSERNAME: 'a', USER: 'c' })).toBe('c')
      expect(databaseOf(empty, 'bun', { PGUSERNAME: 'a' })).toBe(userInfo().username)
    })
  })
}
