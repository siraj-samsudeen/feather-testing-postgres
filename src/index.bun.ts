// The root entry under Bun (the "bun" export condition): the runner-free API,
// with no vitest import. The Vitest helpers are stubs that say what to use
// instead, so code importing them still loads.
import type { createPgTest as CreatePgTest } from './server'
import type { createDbTest as CreateDbTest } from './vitest'

export * from './core'

const vitestOnly = (name: string) =>
  new Error(
    `feather-testing-postgres: ${name} is the Vitest helper (test.extend) and needs vitest. ` +
      "Under bun test use sandboxEach / useBunFixtures from 'feather-testing-postgres/bun', " +
      "or postgresFixtures() with feather-testing-core's defineTest.",
  )

export const createPgTest: typeof CreatePgTest = () => {
  throw vitestOnly('createPgTest')
}

export const createDbTest: typeof CreateDbTest = () => {
  throw vitestOnly('createDbTest')
}
