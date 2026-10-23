// The root entry under Bun (the "bun" export condition): the runner-free API,
// with no vitest import. The Vitest helpers are stubs that say what to use
// instead, so code importing them still loads.
import type { PgTestBindings, PgTestOptions } from './client'
import type { FeatherDb, FeatherDbOptions } from './engine'

export * from './core'

const vitestOnly = (name: string) =>
  new Error(
    `feather-testing-postgres: ${name} is the Vitest helper (test.extend) and needs vitest. ` +
      "Under bun test use sandboxEach / useBunFixtures from 'feather-testing-postgres/bun', " +
      "or postgresFixtures() with feather-testing-core's defineTest.",
  )

export const createPgTest = (_bindings: PgTestBindings, _options?: PgTestOptions): never => {
  throw vitestOnly('createPgTest')
}

export const createDbTest = (_options?: FeatherDbOptions | FeatherDb): never => {
  throw vitestOnly('createDbTest')
}
