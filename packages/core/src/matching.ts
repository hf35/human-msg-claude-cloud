import { sql } from 'drizzle-orm';
import { userIsAvailable } from './availability';
import type { CommandContext } from './context';

/** The question a receiver is being picked for. */
export interface QuestionToAssign {
  id: string;
  authorId: string;
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
 * same transaction. The unique index on active assignments still backs this up.
 */
export async function findReceiver(
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
    FOR UPDATE OF "users" SKIP LOCKED`);
  return result.rows[0]?.id;
}
