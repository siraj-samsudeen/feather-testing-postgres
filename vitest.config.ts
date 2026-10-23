import { defineConfig } from 'vitest/config'

// FEATHER_DB picks the engine lane: pglite (default, nothing to install) or
// postgres (needs DATABASE_URL). The postgres.js delegate suite
// (tests/sandbox.test.ts) needs a real server, so it runs in the postgres lane.
const postgresLane = process.env.FEATHER_DB === 'postgres'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // tests/bun/ is the bun:test lane (`npm run test:bun:*`).
    exclude: ['tests/bun/**', 'node_modules/**', ...(postgresLane ? [] : ['tests/sandbox.test.ts'])],
    environment: 'jsdom',
    // Every engine test runs inside a transaction on one connection (or one
    // PGlite instance); parallel files would contend for the database.
    fileParallelism: false,
  },
})
