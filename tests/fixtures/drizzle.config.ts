import { defineConfig } from 'drizzle-kit'
export default defineConfig({
  dialect: 'postgresql',
  schema: './tests/fixtures/schema.ts',
  out: './tests/fixtures/migrations',
})
