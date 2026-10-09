import { sql } from 'drizzle-orm';
import { bigint, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** Events to deliver to users (transactional outbox); a dispatcher sends them and retries. */
export const outbox = pgTable(
  'outbox',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamptz('next_attempt_at').notNull().defaultNow(),
    deliveredAt: timestamptz('delivered_at'),
    lastError: text('last_error'),
  },
  (table) => [
    // Dispatcher: undelivered events that are due
    index('outbox_pending_idx')
      .on(table.nextAttemptAt)
      .where(sql`${table.deliveredAt} IS NULL`),
    // Cleanup: delivered events that are old enough to delete
    index('outbox_delivered_idx')
      .on(table.deliveredAt)
      .where(sql`${table.deliveredAt} IS NOT NULL`),
  ],
);

export type OutboxEvent = typeof outbox.$inferSelect;
export type NewOutboxEvent = typeof outbox.$inferInsert;
