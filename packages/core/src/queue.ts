import { sql } from 'drizzle-orm';
import type { CommandContext } from './context';
import { lockedUserIsFree } from './matching';
import { assignQuestion } from './questions';

/**
 * The reverse of `findReceiver`: a user who just became a suitable receiver (connected,
 * turned "do not disturb" off, came back after blocking the bot, or their cooldown ended)
 * takes the oldest suitable question from the queue (rule 5, FIFO). Returns the id of the
 * assigned question, or `undefined` if the user cannot receive now or nothing fits.
 *
 * The same rules as in `findReceiver` apply (rule 6), seen from the user's side. The user's row
 * is locked first (`SKIP LOCKED`: someone else is already assigning to them), then the checks
 * run in a new statement so they see everything committed before the lock was taken. The
 * unique index on active assignments backs this up.
 */
export async function assignFromQueue(
  ctx: CommandContext,
  userId: string,
): Promise<string | undefined> {
  const { tx, time } = ctx;
  const now = time.now();

  const locked = await tx.execute(
    sql`SELECT "users"."id" FROM "users" WHERE "users"."id" = ${userId}
      FOR NO KEY UPDATE SKIP LOCKED`,
  );
  if (locked.rows.length === 0) return undefined;
  if (!(await lockedUserIsFree(ctx, userId))) return undefined;

  const picked = await tx.execute<{ id: string; text: string; author_id: string }>(sql`
    SELECT "questions"."id", "questions"."text", "questions"."author_id" FROM "questions"
    JOIN "users" AS "author" ON "author"."id" = "questions"."author_id"
    JOIN "users" AS "receiver" ON "receiver"."id" = ${userId}
    WHERE "questions"."status" = 'queued'
      AND "questions"."expires_at" > ${now}
      AND "author"."is_test" = "receiver"."is_test"
      AND "questions"."author_id" <> ${userId}
      AND NOT EXISTS (
        SELECT 1 FROM "assignments"
        WHERE "assignments"."question_id" = "questions"."id"
          AND "assignments"."receiver_id" = ${userId})
      AND NOT EXISTS (
        SELECT 1 FROM "blocks"
        WHERE "blocks"."author_id" = "questions"."author_id"
          AND "blocks"."receiver_id" = ${userId})
    ORDER BY "questions"."created_at", "questions"."id"
    LIMIT 1
    FOR NO KEY UPDATE OF "questions" SKIP LOCKED`);
  const question = picked.rows[0];
  if (!question) return undefined;

  await assignQuestion(
    ctx,
    { id: question.id, text: question.text, authorId: question.author_id },
    userId,
  );
  return question.id;
}
