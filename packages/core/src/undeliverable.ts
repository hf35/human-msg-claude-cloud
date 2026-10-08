import { assignments, users } from '@human-msg/db';
import { and, eq, isNull } from 'drizzle-orm';
import type { CommandContext } from './context';
import { assignFromQueue } from './queue';
import { releaseAssignment } from './questions';
import { fail, ok, type Result } from './result';

/**
 * Rule 11: Telegram says the user blocked the bot. The user becomes unavailable and the
 * question assigned to them is taken back at once, without waiting for the deadline, and goes
 * on to someone else (or back to the queue). No cooldown: it was not their choice to skip.
 * Repeated reports are harmless; the first time of blocking is kept.
 */
export async function markUndeliverable(
  ctx: CommandContext,
  userId: string,
): Promise<Result<void, 'user_not_found' | 'not_a_telegram_user'>> {
  const { tx, time } = ctx;
  const [user] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
  if (!user) return fail('user_not_found');
  if (user.channel !== 'telegram') return fail('not_a_telegram_user');

  if (user.botBlockedAt === null) {
    await tx.update(users).set({ botBlockedAt: time.now() }).where(eq(users.id, userId));
  }
  const [assignment] = await tx
    .select({
      id: assignments.id,
      questionId: assignments.questionId,
      receiverId: assignments.receiverId,
    })
    .from(assignments)
    .where(and(eq(assignments.receiverId, userId), isNull(assignments.outcome)))
    .for('update');
  if (assignment) await releaseAssignment(ctx, assignment, 'undeliverable', null);
  return ok();
}

/**
 * The user wrote to the bot again, so it is no longer blocked: they are available again and may
 * take a question from the queue.
 */
export async function markReachable(
  ctx: CommandContext,
  userId: string,
): Promise<Result<void, 'user_not_found' | 'not_a_telegram_user'>> {
  const [user] = await ctx.tx.select().from(users).where(eq(users.id, userId)).for('update');
  if (!user) return fail('user_not_found');
  if (user.channel !== 'telegram') return fail('not_a_telegram_user');
  if (user.botBlockedAt === null) return ok();
  await ctx.tx.update(users).set({ botBlockedAt: null }).where(eq(users.id, userId));
  await assignFromQueue(ctx, userId);
  return ok();
}
