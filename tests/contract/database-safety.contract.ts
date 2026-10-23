// The postgres engine never runs against a non-test database by accident:
// url option > FEATHER_DATABASE_URL > TEST_DATABASE_URL > DATABASE_URL, and
// DATABASE_URL only when its database is named like a test database (or with
// allowAnyDatabase: true). Pure resolution — runs in every lane.
import { createFeatherDb, resolveTestDatabaseUrl } from '../../src/engine'
import type { RunnerApi } from './runner'

const url = (db: string, host = 'localhost:5432') => `postgres://${host}/${db}`

export function databaseSafetyContract({ describe, test, expect }: RunnerApi) {
  describe('test-database safety', () => {
    test('precedence: url option, FEATHER_DATABASE_URL, TEST_DATABASE_URL, DATABASE_URL', () => {
      const env = {
        FEATHER_DATABASE_URL: url('feather_one'),
        TEST_DATABASE_URL: url('test_two'),
        DATABASE_URL: url('app_test'),
      }
      expect(resolveTestDatabaseUrl({ url: url('explicit') }, env)).toBe(url('explicit'))
      expect(resolveTestDatabaseUrl({}, env)).toBe(url('feather_one'))
      expect(resolveTestDatabaseUrl({}, { ...env, FEATHER_DATABASE_URL: undefined })).toBe(url('test_two'))
      expect(resolveTestDatabaseUrl({}, { DATABASE_URL: url('app_test') })).toBe(url('app_test'))
    })

    test('DATABASE_URL is accepted for test-named databases', () => {
      for (const name of ['app_test', 'test', 'test_db', 'my-test-db', 'ftp_port_test', 'feather_test', 'tests'])
        expect(resolveTestDatabaseUrl({}, { DATABASE_URL: url(name) })).toBe(url(name))
    })

    test('DATABASE_URL naming any other database is refused, saying how to opt in', () => {
      for (const name of ['production', 'app', 'contest', 'latest_orders', 'testing_prod']) {
        let message = ''
        try {
          resolveTestDatabaseUrl({}, { DATABASE_URL: url(name) })
        } catch (e) {
          message = String(e)
        }
        expect(message).toContain(`"${name}"`)
        expect(message).toMatch(/FEATHER_DATABASE_URL|TEST_DATABASE_URL/)
        expect(message).toMatch(/allowAnyDatabase/)
      }
    })

    test('allowAnyDatabase: true accepts any DATABASE_URL', () => {
      expect(resolveTestDatabaseUrl({ allowAnyDatabase: true }, { DATABASE_URL: url('production') })).toBe(url('production'))
    })

    test('no url at all: a clear error', () => {
      expect(() => resolveTestDatabaseUrl({}, {})).toThrow(/DATABASE_URL/)
    })

    test('start() refuses before connecting (an unreachable host never gets a connection attempt)', async () => {
      const saved = { ...process.env }
      try {
        delete process.env.FEATHER_DATABASE_URL
        delete process.env.TEST_DATABASE_URL
        process.env.DATABASE_URL = url('production', 'nohost.invalid:1')
        const fdb = createFeatherDb({ engine: 'postgres', driver: 'postgres-js' })
        await expect(fdb.start()).rejects.toThrow(/"production"/)
        await fdb.close()
      } finally {
        process.env = saved
      }
    })
  })
}
