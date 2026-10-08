import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** Sessions of web users and of the back office admin. */
export const sessions = pgTable(
  'sessions',
  {
    /** Hash of the random token; the token itself is never stored. */
    id: text('id').primaryKey(),
    /** Set for a web user's session; `NULL` for an admin session. */
    userId: uuid('user_id').references(() => users.id),
    isAdmin: boolean('is_admin').notNull().default(false),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at').notNull(),
  },
  (table) => [
    // A session belongs either to a user or to the admin
    check('sessions_user_xor_admin', sql`(${table.userId} IS NOT NULL) <> ${table.isAdmin}`),
    index('sessions_user_idx').on(table.userId),
    // Cleanup of expired sessions
    index('sessions_expires_idx').on(table.expiresAt),
  ],
);

export type Session = typeof sessions.$inferSelect;
