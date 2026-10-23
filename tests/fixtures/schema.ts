// The schema the engine tests run against. Its migrations folder is generated
// by drizzle-kit (`drizzle-kit generate --config tests/fixtures/drizzle.config.ts`)
// so `migrateOnce` is exercised on a real drizzle-kit layout.
import { boolean, integer, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core'

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
})

export const todos = pgTable('todos', {
  id: serial('id').primaryKey(),
  ownerId: integer('owner_id').references(() => users.id),
  title: text('title').notNull(),
  done: boolean('done').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})
