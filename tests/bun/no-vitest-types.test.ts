// Type-checking without vitest: a consumer with no vitest installed runs tsc
// over code importing the runner-free API. With customConditions ["bun"] the
// root entry resolves to index.bun.ts; the runner-free subpaths need no
// condition. (The root's default entry is the Vitest entry and needs vitest.)
import { expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT_IMPORTS = `
import { createFeatherDb, createPgTest, makeClient, postgresFixtures, type PgTestBindings, type DbTestFixtures, type TestDb } from 'feather-testing-postgres'
const fdb = createFeatherDb({ engine: 'pglite' })
const t: Promise<TestDb> = fdb.beginTest()
const bindings = {} as PgTestBindings
void createPgTest; void makeClient; void postgresFixtures; void t; void bindings
const f = {} as DbTestFixtures
void f
`
const SUBPATH_IMPORTS = `
import { createFeatherDb, type RawSql } from 'feather-testing-postgres/engine'
import { postgresFixtures, useFixtures } from 'feather-testing-postgres/fixtures'
import { sandboxEach } from 'feather-testing-postgres/bun'
import { factory } from 'feather-testing-postgres/drizzle'
void createFeatherDb; void postgresFixtures; void useFixtures; void sandboxEach; void factory
const r = {} as RawSql
void r
`

function consumer(files: Record<string, string>, customConditions: string[] | undefined) {
  const root = new URL('../..', import.meta.url).pathname
  const dir = mkdtempSync(join(tmpdir(), 'ftp-no-vitest-types-'))
  const pkg = join(dir, 'node_modules', 'feather-testing-postgres')
  mkdirSync(pkg, { recursive: true })
  cpSync(join(root, 'package.json'), join(pkg, 'package.json'))
  cpSync(join(root, 'src'), join(pkg, 'src'), { recursive: true })
  for (const dep of ['@electric-sql/pglite', 'drizzle-orm', 'typescript', '@types/bun', 'bun-types', '@types/node', 'undici-types']) {
    mkdirSync(join(dir, 'node_modules', dep, '..'), { recursive: true })
    symlinkSync(realpathSync(join(root, 'node_modules', dep)), join(dir, 'node_modules', dep))
  }
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, noEmit: true,
        skipLibCheck: true, types: ['bun'], ...(customConditions ? { customConditions } : {}),
      },
      include: Object.keys(files),
    }),
  )
  const run = Bun.spawnSync([process.execPath, join(dir, 'node_modules/typescript/bin/tsc'), '-p', dir], { cwd: dir })
  const output = run.stdout.toString() + run.stderr.toString()
  rmSync(dir, { recursive: true, force: true })
  return { code: run.exitCode, output }
}

test('with customConditions ["bun"], the root entry and the subpaths type-check without vitest', () => {
  const r = consumer({ 'root.ts': ROOT_IMPORTS, 'subpaths.ts': SUBPATH_IMPORTS }, ['bun'])
  expect(r.output).toBe('')
  expect(r.code).toBe(0)
}, 60_000)

test('without a condition, the runner-free subpaths type-check without vitest', () => {
  const r = consumer({ 'subpaths.ts': SUBPATH_IMPORTS }, undefined)
  expect(r.output).toBe('')
  expect(r.code).toBe(0)
}, 60_000)
