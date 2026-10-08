import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { questions } from './questions';
import { users } from './users';

export const ASSIGNMENT_OUTCOMES = [
  'answered',
  'timed_out',
  'skipped',
  'reported',
  'undeliverable',
] as const;
export type AssignmentOutcome = (typeof ASSIGNMENT_OUTCOMES)[number];

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * A question handed to a receiver. An assignment is active while `outcome` is NULL; ended
 * assignments stay as history, which is also what prevents assigning a question twice (rule 6).
 */
export const assignments = pgTable(
  'assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    questionId: uuid('question_id')
      .notNull()
      .references(() => questions.id),
    receiverId: uuid('receiver_id')
      .notNull()
      .references(() => users.id),
    assignedAt: timestamptz('assigned_at').notNull().defaultNow(),
    /** Fixed at assignment time: later changes of ANSWER_TIMEOUT do not affect it. */
    deadlineAt: timestamptz('deadline_at').notNull(),
    remindedAt: timestamptz('reminded_at'),
    endedAt: timestamptz('ended_at'),
    /** `NULL` means the assignment is still active. */
    outcome: text('outcome', { enum: ASSIGNMENT_OUTCOMES }),
  },
  (table) => [
    check(
      'assignments_outcome_valid',
      sql`${table.outcome} IN ('answered', 'timed_out', 'skipped', 'reported', 'undeliverable')`,
    ),
    // An assignment has an end time if and only if it has an outcome
    check(
      'assignments_ended_at_matches_outcome',
      sql`(${table.outcome} IS NULL) = (${table.endedAt} IS NULL)`,
    ),
    check('assignments_deadline_after_assigned', sql`${table.deadlineAt} > ${table.assignedAt}`),
    // Rule 3: a receiver has at most one unanswered question
    uniqueIndex('assignments_one_active_per_receiver_idx')
      .on(table.receiverId)
      .where(sql`${table.outcome} IS NULL`),
    // A question has at most one active assignment
    uniqueIndex('assignments_one_active_per_question_idx')
      .on(table.questionId)
      .where(sql`${table.outcome} IS NULL`),
    // Rule 6: a receiver never gets the same question twice
    unique('assignments_question_receiver_unique').on(table.questionId, table.receiverId),
    // Deadline scanner
    index('assignments_deadline_idx')
      .on(table.deadlineAt)
      .where(sql`${table.outcome} IS NULL`),
  ],
);

export type Assignment = typeof assignments.$inferSelect;
export type NewAssignment = typeof assignments.$inferInsert;
