import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // tests/bun/ is the bun:test lane (`npm run test:bun`).
    exclude: ['tests/bun/**', 'node_modules/**'],
    environment: 'jsdom',
    // The sandbox suite opens one real Postgres connection and every test in
    // it runs inside a transaction on that connection; parallel files would
    // contend for it.
    fileParallelism: false,
  },
})
