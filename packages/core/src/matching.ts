import type { Tx } from '@human-msg/db';
import { sql } from 'drizzle-orm';
import { userIsAvailable } from './user-available';
import type { CommandContext } from './context';

/** The question a receiver is being picked for. */
export interface QuestionToAssign {
  id: string;
  authorId: string;
}

/** Candidates tried before giving up when each one turns out to be taken by a parallel command. */
const MAX_PICK_ATTEMPTS = 5;

/**
 * Whether a user whose row this transaction has locked can receive a question right now:
 * not staff, available, not busy, not on cooldown. It runs as a statement of its own, after the
 * lock, so it sees everything that parallel commands committed before the lock was granted;
 * the picking queries cannot promise that, because they decide and lock in one statement.
 */
export async function lockedUserIsFree(ctx: CommandContext, userId: string): Promise<boolean> {
  const rows = await ctx.tx.execute(sql`
    SELECT 1 FROM "users"
    WHERE "users"."id" = ${userId}
      AND "users"."is_staff" = false
      AND ${userIsAvailable}
      AND NOT EXISTS (
        SELECT 1 FROM "assignments"
        WHERE "assignments"."receiver_id" = "users"."id" AND "assignments"."outcome" IS NULL)
      AND ("users"."cooldown_until" IS NULL OR "users"."cooldown_until" <= ${ctx.time.now()})`);
  return rows.rows.length > 0;
}

/**
 * Locks a user's row for the rest of the transaction. Commands that end or change an
 * assignment take this lock before the assignment's own lock, so they all lock in the same
 * order and cannot deadlock. `NO KEY UPDATE` does not block inserts that refer to the user.
 */
export async function lockUser(tx: Tx, userId: string): Promise<boolean> {
  const rows = await tx.execute(
    sql`SELECT 1 FROM "users" WHERE "users"."id" = ${userId} FOR NO KEY UPDATE`,
  );
  return rows.rows.length > 0;
}

/**
 * Picks a random user who may receive the question (rule 6) and locks their row, so a parallel
 * transaction picking a receiver skips them and takes another one. Returns `undefined` when
 * nobody fits; the caller then queues the question (rule 5).
 *
 * A candidate is:
 * - in the author's pool (live with live, test with test), not staff, not the author;
 * - available (`userIsAvailable`);
 * - not busy: no active assignment (rule 3);
 * - not on cooldown (rule 9);
 * - never assigned this question before (timed out, skipped, reported, ...);
 * - not blocked for this author's questions (`blocks`).
 *
 * The lock is held until the transaction ends, so the caller must insert the assignment in the
 * same transaction. The query decides and locks in one statement, so a parallel command may have
 * given the candidate a question just before the lock was granted; the candidate is therefore
 * checked again once locked (`lockedUserIsFree`) and another one is tried if needed. The unique
 * index on active assignments is the last line of defence (rule 3).
 */
export async function findReceiver(
  ctx: CommandContext,
  question: QuestionToAssign,
): Promise<string | undefined> {
  for (let attempt = 0; attempt < MAX_PICK_ATTEMPTS; attempt++) {
    const picked = await pickCandidate(ctx, question);
    if (picked === undefined) return undefined;
    if (await lockedUserIsFree(ctx, picked)) return picked;
  }
  return undefined;
}

async function pickCandidate(
  ctx: CommandContext,
  question: QuestionToAssign,
): Promise<string | undefined> {
  const now = ctx.time.now();
  const result = await ctx.tx.execute<{ id: string }>(sql`
    SELECT "users"."id" FROM "users"
    JOIN "users" AS "author" ON "author"."id" = ${question.authorId}
    WHERE "users"."is_staff" = false
      AND "users"."is_test" = "author"."is_test"
      AND "users"."id" <> "author"."id"
      AND ${userIsAvailable}
      AND NOT EXISTS (
        SELECT 1 FROM "assignments"
        WHERE "assignments"."receiver_id" = "users"."id" AND "assignments"."outcome" IS NULL)
      AND ("users"."cooldown_until" IS NULL OR "users"."cooldown_until" <= ${now})
      AND NOT EXISTS (
        SELECT 1 FROM "assignments"
        WHERE "assignments"."receiver_id" = "users"."id"
          AND "assignments"."question_id" = ${question.id})
      AND NOT EXISTS (
        SELECT 1 FROM "blocks"
        WHERE "blocks"."author_id" = ${question.authorId}
          AND "blocks"."receiver_id" = "users"."id")
    ORDER BY random()
    LIMIT 1
    FOR NO KEY UPDATE OF "users" SKIP LOCKED`);
  return result.rows[0]?.id;
}
