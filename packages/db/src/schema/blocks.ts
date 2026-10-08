import { sql } from 'drizzle-orm';
import { check, pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';
import { questions } from './questions';
import { users } from './users';

/**
 * One-way exclusions made by complaints: questions of `authorId` are never assigned to
 * `receiverId`. Whichever side complained, the direction is the same (see CLAUDE.md).
 */
export const blocks = pgTable(
  'blocks',
  {
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id),
    receiverId: uuid('receiver_id')
      .notNull()
      .references(() => users.id),
    /** Who complained: the author (about an answer) or the receiver (about a question). */
    reportedBy: uuid('reported_by')
      .notNull()
      .references(() => users.id),
    /** The question the complaint is about. */
    questionId: uuid('question_id')
      .notNull()
      .references(() => questions.id),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.authorId, table.receiverId] }),
    check(
      'blocks_reporter_is_a_party',
      sql`${table.reportedBy} IN (${table.authorId}, ${table.receiverId})`,
    ),
    check('blocks_not_self', sql`${table.authorId} <> ${table.receiverId}`),
  ],
);

export type Block = typeof blocks.$inferSelect;
export type NewBlock = typeof blocks.$inferInsert;
