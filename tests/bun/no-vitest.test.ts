// vitest is an optional peer: a bun-only consumer imports the root entry
// (resolved through the "bun" export condition) with no vitest installed.
// A consumer project is assembled in a temp dir — the package (its
// package.json exports and src), PGlite and drizzle, no vitest — and runs a
// bun test there.
import { expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CONSUMER_TEST = `
import { expect, test } from 'bun:test'
import { createDbTest, createFeatherDb, createPgTest, makeClient, TestApiError, postgresFixtures } from 'feather-testing-postgres'

test('the root entry loads and works without vitest', async () => {
  const fdb = createFeatherDb({ engine: 'pglite', setup: (sql) => sql\`create table notes (body text)\` })
  const t = await fdb.beginTest()
  await t.sql\`insert into notes values ('x')\`
  expect((await t.sql\`select * from notes\`).length).toBe(1)
  await fdb.endTest()
  await fdb.close()
  expect(typeof makeClient).toBe('function')
  expect(typeof TestApiError).toBe('function')
  expect(typeof postgresFixtures).toBe('function')
})

test('the Vitest helpers explain themselves instead of failing to load', () => {
  expect(() => createPgTest({} as any)).toThrow(/vitest/i)
  expect(() => createDbTest()).toThrow(/feather-testing-postgres\\/bun/)
})
`

test('importing feather-testing-postgres under bun needs no vitest', () => {
  const root = new URL('../..', import.meta.url).pathname
  const dir = mkdtempSync(join(tmpdir(), 'ftp-no-vitest-'))
  try {
    const pkg = join(dir, 'node_modules', 'feather-testing-postgres')
    mkdirSync(pkg, { recursive: true })
    cpSync(join(root, 'package.json'), join(pkg, 'package.json'))
    cpSync(join(root, 'src'), join(pkg, 'src'), { recursive: true })
    for (const dep of ['@electric-sql/pglite', 'drizzle-orm']) {
      mkdirSync(join(dir, 'node_modules', dep, '..'), { recursive: true })
      symlinkSync(realpathSync(join(root, 'node_modules', dep)), join(dir, 'node_modules', dep))
    }
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }))
    writeFileSync(join(dir, 'consumer.test.ts'), CONSUMER_TEST)
    const run = Bun.spawnSync([process.execPath, 'test', './consumer.test.ts'], { cwd: dir, env: { ...process.env } })
    const output = run.stdout.toString() + run.stderr.toString()
    expect(output).toContain(' 2 pass')
    expect(run.exitCode).toBe(0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 60_000)
