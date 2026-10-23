// The postgres engine never runs against a non-test database by accident:
// url option > FEATHER_DATABASE_URL > TEST_DATABASE_URL > DATABASE_URL, and
// DATABASE_URL only when its database is named like a test database (or with
// allowAnyDatabase: true). Pure resolution — runs in every lane.
import { createFeatherDb, resolveTestDatabaseUrl } from '../../src/engine'
import { libraryUrl } from '../../src/drivers'
import type { RunnerApi } from './runner'

const url = (db: string, host = 'localhost:5432') => `postgres://${host}/${db}`

export function databaseSafetyContract({ describe, test, expect }: RunnerApi) {
  describe('test-database safety', () => {
    test('precedence: url option, FEATHER_DATABASE_URL, TEST_DATABASE_URL, DATABASE_URL', () => {
      const env = {
        FEATHER_DATABASE_URL: url('feather_one_test'),
        TEST_DATABASE_URL: url('test_two'),
        DATABASE_URL: url('app_test'),
      }
      expect(resolveTestDatabaseUrl({ url: url('explicit_test') }, env)).toBe(url('explicit_test'))
      expect(resolveTestDatabaseUrl({}, env)).toBe(url('feather_one_test'))
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

    test('the test-name rule applies to every source, explicit URLs included', () => {
      for (const options of [{ url: url('production') }, {}])
        expect(() =>
          resolveTestDatabaseUrl(options, { FEATHER_DATABASE_URL: url('production'), TEST_DATABASE_URL: url('production') }),
        ).toThrow(/"production"/)
      expect(resolveTestDatabaseUrl({ url: url('production'), allowAnyDatabase: true }, {})).toBe(url('production'))
    })

    test('a URL selecting its database outside the path is refused, from every source', () => {
      for (const q of ['database=production', 'dbname=production', 'db=production', 'DATABASE=production', 'sslmode=disable&database=x'])
        for (const env of [{}, { FEATHER_DATABASE_URL: url(`app_test?${q}`) }, { DATABASE_URL: url(`app_test?${q}`) }]) {
          const options = Object.keys(env).length ? {} : { url: url(`app_test?${q}`) }
          expect(() => resolveTestDatabaseUrl(options, env)).toThrow(/outside its path/)
          // not even allowAnyDatabase: the path must be what's used
          expect(() => resolveTestDatabaseUrl({ ...options, allowAnyDatabase: true }, env)).toThrow(/outside its path/)
        }
      // other parameters are fine
      expect(resolveTestDatabaseUrl({ url: url('app_test?sslmode=disable') }, {})).toBe(url('app_test?sslmode=disable'))
    })

    test('a URL must name its database: an empty path is refused, from every source', () => {
      for (const u of ['postgres://localhost:5432', 'postgres://localhost:5432/', 'postgres://u:p@localhost:5432?sslmode=disable'])
        for (const [options, env] of [
          [{ url: u }, {}],
          [{}, { FEATHER_DATABASE_URL: u }],
          [{}, { DATABASE_URL: u }],
          [{ url: u, allowAnyDatabase: true }, {}],
        ] as const)
          expect(() => resolveTestDatabaseUrl(options, env)).toThrow(/must name its database, e\.g\. postgres:\/\/…\/app_test/)
    })

    test('one URL means one server: several hosts are refused, from every source', () => {
      const ONE = /one server/
      for (const u of ['postgres://h1:5432,h2:5432/app_test', 'postgres://u:p@h1,h2/app_test'])
        for (const [options, env] of [
          [{ url: u }, {}],
          [{}, { FEATHER_DATABASE_URL: u }],
          [{}, { DATABASE_URL: u }],
          [{ url: u, allowAnyDatabase: true }, {}],
        ] as const)
          expect(() => resolveTestDatabaseUrl(options, env)).toThrow(ONE)
      // hosts given as parameters, and PGHOST lists when the URL names no host
      for (const q of ['host=/tmp', 'hostaddr=10.0.0.1', 'HOST=h2', 'path=/tmp&path=/var/run'])
        expect(() => resolveTestDatabaseUrl({ url: url(`app_test?${q}`) }, {})).toThrow(ONE)
      expect(() => resolveTestDatabaseUrl({ url: 'postgres:///app_test' }, { PGHOST: 'h1,h2' })).toThrow(ONE)
      // a single socket is one server
      expect(resolveTestDatabaseUrl({ url: url('app_test?path=/tmp') }, {})).toBe(url('app_test?path=/tmp'))
      expect(resolveTestDatabaseUrl({ url: 'postgres:///app_test' }, { PGHOST: '/tmp' })).toBe('postgres:///app_test')
    })

    test('target_session_attrs is refused, from the URL and PGTARGETSESSIONATTRS', () => {
      for (const q of ['target_session_attrs=read-write', 'TARGET_SESSION_ATTRS=primary'])
        expect(() => resolveTestDatabaseUrl({ url: url(`app_test?${q}`) }, {})).toThrow(/target_session_attrs/)
      expect(() => resolveTestDatabaseUrl({ url: url('app_test') }, { PGTARGETSESSIONATTRS: 'read-write' })).toThrow(
        /PGTARGETSESSIONATTRS/,
      )
    })

    test("library connections keep transport (ssl, Bun's socket path) and nothing else", () => {
      const kept = new URL(libraryUrl(url('app_test?sslmode=require&path=/tmp&search_path=evil&options=-c%20x%3Dy&application_name=a')))
      expect([...kept.searchParams.keys()].sort()).toEqual(['path', 'sslmode'])
      expect(kept.pathname).toBe('/app_test')
    })

    test('allowAnyDatabase: true accepts any DATABASE_URL', () => {
      expect(resolveTestDatabaseUrl({ allowAnyDatabase: true }, { DATABASE_URL: url('production') })).toBe(url('production'))
    })

    test('no url at all: a clear error', () => {
      expect(() => resolveTestDatabaseUrl({}, {})).toThrow(/DATABASE_URL/)
    })

    test('start() refuses a database selector before connecting', async () => {
      const fdb = createFeatherDb({ engine: 'postgres', driver: 'postgres-js', url: url('app_test?database=production', 'nohost.invalid:1') })
      await expect(fdb.start()).rejects.toThrow(/outside its path/)
      await fdb.close()
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
