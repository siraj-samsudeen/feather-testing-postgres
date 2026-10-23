// drizzle-orm is an optional peer: raw-SQL tests must work without it. The
// library is copied into a temp dir whose node_modules holds only PGlite, and
// a sql-only suite runs there in a child `bun test`.
import { expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SQL_ONLY = `
import { expect, test } from 'bun:test'
import { sandboxEach } from './src/bun'

const t = sandboxEach({ setup: (sql) => sql\`create table notes (id serial primary key, body text)\` })

test('writes through sql', async () => {
  await t.sql\`insert into notes (body) values ('x')\`
  expect((await t.sql\`select * from notes\`).length).toBe(1)
})
test('rolled back', async () => {
  expect((await t.sql\`select * from notes\`).length).toBe(0)
})
test('db explains what is missing', () => {
  expect(() => t.db.select).toThrow(/drizzle-orm/)
})
`

test('sandboxEach serves sql-only tests when drizzle-orm is not installed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ftp-no-drizzle-'))
  try {
    cpSync(new URL('../../src', import.meta.url).pathname, join(dir, 'src'), { recursive: true })
    mkdirSync(join(dir, 'node_modules', '@electric-sql'), { recursive: true })
    symlinkSync(
      realpathSync(new URL('../../node_modules/@electric-sql/pglite', import.meta.url).pathname),
      join(dir, 'node_modules', '@electric-sql', 'pglite'),
    )
    writeFileSync(join(dir, 'sql-only.test.ts'), SQL_ONLY)
    const run = Bun.spawnSync([process.execPath, 'test', './sql-only.test.ts'], {
      cwd: dir,
      env: { ...process.env, FEATHER_DB: 'pglite' },
    })
    const output = run.stdout.toString() + run.stderr.toString()
    expect(output).toContain(' 3 pass')
    expect(run.exitCode).toBe(0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 60_000)
