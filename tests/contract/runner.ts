// The slice of a test runner the shared contract suites need. bun:test and
// vitest both satisfy it, so each suite is written once and run by both lanes.
// The runners' own overloads differ, so the slots are typed loosely.
type Fn = (...args: any[]) => any
export interface RunnerApi {
  describe: Fn
  test: Fn
  expect: any
  beforeAll: Fn
  afterAll: Fn
  beforeEach: Fn
  afterEach: Fn
}

export const MIGRATIONS = new URL('../fixtures/migrations', import.meta.url).pathname

/** The engine under test, from FEATHER_DB (default pglite). */
export const ENGINE = (process.env.FEATHER_DB ?? 'pglite') as 'pglite' | 'postgres'
