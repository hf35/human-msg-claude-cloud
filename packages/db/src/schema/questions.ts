import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

export const QUESTION_STATUSES = ['queued', 'assigned', 'answered', 'expired'] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const questions = pgTable(
  'questions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id),
    text: text('text').notNull(),
    status: text('status', { enum: QUESTION_STATUSES }).notNull().default('queued'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    /** Fixed at creation: later changes of QUESTION_TTL do not affect existing questions. */
    expiresAt: timestamptz('expires_at').notNull(),
    answeredAt: timestamptz('answered_at'),
  },
  (table) => [
    check(
      'questions_status_valid',
      sql`${table.status} IN ('queued', 'assigned', 'answered', 'expired')`,
    ),
    // A question is answered if and only if it has an answer time
    check(
      'questions_answered_at_matches_status',
      sql`(${table.status} = 'answered') = (${table.answeredAt} IS NOT NULL)`,
    ),
    // FIFO queue
    index('questions_queue_idx')
      .on(table.createdAt)
      .where(sql`${table.status} = 'queued'`),
    // Scanner that expires queued questions
    index('questions_expiry_idx')
      .on(table.expiresAt)
      .where(sql`${table.status} = 'queued'`),
    // History of a user's own questions
    index('questions_author_created_idx').on(table.authorId, table.createdAt),
  ],
);

export const answers = pgTable('answers', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Unique: one question has at most one answer (rule 4). */
  questionId: uuid('question_id')
    .notNull()
    .unique()
    .references(() => questions.id),
  /** The user who answered (a staff user for answers from the back office). */
  authorId: uuid('author_id')
    .notNull()
    .references(() => users.id),
  text: text('text').notNull(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});

export type Question = typeof questions.$inferSelect;
export type NewQuestion = typeof questions.$inferInsert;
export type Answer = typeof answers.$inferSelect;
export type NewAnswer = typeof answers.$inferInsert;
