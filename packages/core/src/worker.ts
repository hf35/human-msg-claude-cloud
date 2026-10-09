import { assignments, outbox, questions, users } from '@human-msg/db';
import { and, asc, eq, gt, isNotNull, isNull, lt, lte, sql } from 'drizzle-orm';
import type { Core } from './core';
import { findReceiver, lockUser } from './matching';
import { emit } from './outbox';
import { assignQuestion, releaseAssignment } from './questions';
import { ok } from './result';
import type { CommandContext } from './context';

/** How many records one worker step takes per pass. */
export const WORKER_BATCH_SIZE = 100;

/**
 * The shape shared by every worker step: find the ids of the records that need work, then handle
 * each one in its own transaction, so one failure does not hold the others back. `handle`
 * returns `false` when there was nothing to do. Returns how many records were handled.
 */
async function forEachRecord(
  core: Core,
  find: (ctx: CommandContext) => Promise<string[]>,
  handle: (ctx: CommandContext, id: string) => Promise<boolean>,
): Promise<number> {
  const found = await core.run(async (ctx) => ok(await find(ctx)));
  if (!found.ok) return 0;
  let done = 0;
  for (const id of found.value) {
    const result = await core.run(async (ctx) => ok(await handle(ctx, id)));
    if (result.ok && result.value) done++;
  }
  return done;
}

/** Ids of active assignments whose deadline has passed, oldest deadline first. */
export async function findDueAssignmentIds(
  ctx: CommandContext,
  limit = WORKER_BATCH_SIZE,
): Promise<string[]> {
  const rows = await ctx.tx
    .select({ id: assignments.id })
    .from(assignments)
    .where(and(isNull(assignments.outcome), lte(assignments.deadlineAt, ctx.time.now())))
    .orderBy(asc(assignments.deadlineAt))
    .limit(limit);
  return rows.map((row) => row.id);
}

/**
 * Counts a missed deadline for a Telegram user. After `AUTO_DND_AFTER_MISSED` misses in a row
 * (answers and skips reset the count) "do not disturb" is switched on and the user is told, so
 * people who tried the bot once and left stop wasting the time of questions. The user comes back
 * with `/resume`. Web users are not counted: their availability follows the open page.
 */
async function recordMissedDeadline(ctx: CommandContext, receiverId: string): Promise<void> {
  const { tx, settings } = ctx;
  const [user] = await tx
    .update(users)
    .set({ missedDeadlines: sql`${users.missedDeadlines} + 1` })
    .where(and(eq(users.id, receiverId), eq(users.channel, 'telegram')))
    .returning({ missed: users.missedDeadlines });
  const limit = settings.AUTO_DND_AFTER_MISSED;
  if (!user || limit === 0 || user.missed < limit) return;
  await tx
    .update(users)
    .set({ receivingEnabled: false, missedDeadlines: 0 })
    .where(eq(users.id, receiverId));
  await emit(tx, receiverId, { type: 'receiving.auto_disabled', missedDeadlines: user.missed });
}

/**
 * Ends one assignment whose deadline has passed: outcome `timed_out`, the receiver rests for
 * `COOLDOWN_SKIP`, the question goes on (to someone else or back to the queue), and the receiver
 * is told that the time is over (rule 7).
 *
 * The receiver's row is locked before the assignment, the same order as in `submitAnswer` and
 * `skipAssignment`, so an answer racing with the timeout is either counted or refused, never
 * both. Returns `false` when there was nothing to do: the assignment already ended, its
 * deadline has not come, or another worker holds it.
 */
export async function timeOutAssignment(
  ctx: CommandContext,
  assignmentId: string,
): Promise<boolean> {
  const { tx, time, settings } = ctx;
  const [probe] = await tx
    .select({ receiverId: assignments.receiverId })
    .from(assignments)
    .where(eq(assignments.id, assignmentId));
  if (!probe || !(await lockUser(tx, probe.receiverId))) return false;

  const [assignment] = await tx
    .select({
      id: assignments.id,
      questionId: assignments.questionId,
      receiverId: assignments.receiverId,
    })
    .from(assignments)
    .where(
      and(
        eq(assignments.id, assignmentId),
        isNull(assignments.outcome),
        lte(assignments.deadlineAt, time.now()),
      ),
    )
    .for('no key update', { skipLocked: true });
  if (!assignment) return false;

  await emit(tx, assignment.receiverId, {
    type: 'assignment.expired',
    questionId: assignment.questionId,
  });
  // Before the question is sent on, so a user who just switched themselves off is not picked again
  await recordMissedDeadline(ctx, assignment.receiverId);
  await releaseAssignment(ctx, assignment, 'timed_out', settings.COOLDOWN_SKIP);
  return true;
}

/**
 * Worker step 1: times out every assignment past its deadline. Each assignment is handled in
 * its own transaction, so one failure does not hold the others back. Returns how many were
 * timed out.
 */
export async function processDeadlines(core: Core): Promise<number> {
  return forEachRecord(core, findDueAssignmentIds, timeOutAssignment);
}

/**
 * Ids of active assignments that need a reminder now: `ANSWER_REMINDER` or less is left until
 * the deadline, the deadline has not passed (the deadline step takes those) and no reminder was
 * sent yet.
 */
export async function findReminderAssignmentIds(
  ctx: CommandContext,
  limit = WORKER_BATCH_SIZE,
): Promise<string[]> {
  const { tx, time, settings } = ctx;
  const rows = await tx
    .select({ id: assignments.id })
    .from(assignments)
    .where(
      and(
        isNull(assignments.outcome),
        isNull(assignments.remindedAt),
        gt(assignments.deadlineAt, time.now()),
        lte(
          sql`${assignments.deadlineAt} - ${settings.ANSWER_REMINDER} * interval '1 second'`,
          time.now(),
        ),
      ),
    )
    .orderBy(asc(assignments.deadlineAt))
    .limit(limit);
  return rows.map((row) => row.id);
}

/**
 * Sends the one reminder of an assignment ("N minutes left, answer or skip") and records
 * `reminded_at`, so it is never sent twice. Locks like `timeOutAssignment`; returns `false` when
 * there was nothing to do (already reminded or ended, not yet time, or another worker holds it).
 */
export async function remindAssignment(
  ctx: CommandContext,
  assignmentId: string,
): Promise<boolean> {
  const { tx, time, settings } = ctx;
  const [probe] = await tx
    .select({ receiverId: assignments.receiverId })
    .from(assignments)
    .where(eq(assignments.id, assignmentId));
  if (!probe || !(await lockUser(tx, probe.receiverId))) return false;

  const [assignment] = await tx
    .select({
      id: assignments.id,
      questionId: assignments.questionId,
      receiverId: assignments.receiverId,
      deadlineAt: assignments.deadlineAt,
      secondsLeft: sql<number>`round(extract(epoch FROM ${assignments.deadlineAt} - (${time.now()})))::int`,
    })
    .from(assignments)
    .where(
      and(
        eq(assignments.id, assignmentId),
        isNull(assignments.outcome),
        isNull(assignments.remindedAt),
        gt(assignments.deadlineAt, time.now()),
        lte(
          sql`${assignments.deadlineAt} - ${settings.ANSWER_REMINDER} * interval '1 second'`,
          time.now(),
        ),
      ),
    )
    .for('no key update', { skipLocked: true });
  if (!assignment) return false;

  await tx
    .update(assignments)
    .set({ remindedAt: time.now() })
    .where(eq(assignments.id, assignment.id));
  await emit(tx, assignment.receiverId, {
    type: 'assignment.reminder',
    questionId: assignment.questionId,
    deadlineAt: assignment.deadlineAt.toISOString(),
    secondsLeft: Math.max(0, assignment.secondsLeft),
  });
  return true;
}

/** Worker step 2: sends the due reminders, one transaction each. Returns how many were sent. */
export async function processReminders(core: Core): Promise<number> {
  return forEachRecord(core, findReminderAssignmentIds, remindAssignment);
}

/** Ids of queued questions whose lifetime is over, oldest first. */
export async function findExpiredQuestionIds(
  ctx: CommandContext,
  limit = WORKER_BATCH_SIZE,
): Promise<string[]> {
  const rows = await ctx.tx
    .select({ id: questions.id })
    .from(questions)
    .where(and(eq(questions.status, 'queued'), lte(questions.expiresAt, ctx.time.now())))
    .orderBy(asc(questions.expiresAt))
    .limit(limit);
  return rows.map((row) => row.id);
}

/**
 * Moves one queued question whose `expires_at` has passed to `expired` and tells the author that
 * nobody managed to answer. Only `queued` questions expire: an assigned question keeps its
 * receiver's full `ANSWER_TIMEOUT` and, if that ends without an answer, comes back to the queue
 * and expires on the next pass. Returns `false` when there was nothing to do.
 */
export async function expireQuestion(ctx: CommandContext, questionId: string): Promise<boolean> {
  const { tx, time } = ctx;
  const [question] = await tx
    .select({ id: questions.id, authorId: questions.authorId })
    .from(questions)
    .where(
      and(
        eq(questions.id, questionId),
        eq(questions.status, 'queued'),
        lte(questions.expiresAt, time.now()),
      ),
    )
    .for('no key update', { skipLocked: true });
  if (!question) return false;

  await tx.update(questions).set({ status: 'expired' }).where(eq(questions.id, question.id));
  await emit(tx, question.authorId, { type: 'question.expired', questionId: question.id });
  return true;
}

/** Worker step 3: expires the queued questions that ran out of time. Returns how many. */
export async function processExpiredQuestions(core: Core): Promise<number> {
  return forEachRecord(core, findExpiredQuestionIds, expireQuestion);
}

/** Ids of queued questions that are still alive, oldest first (FIFO, rule 5). */
export async function findQueuedQuestionIds(
  ctx: CommandContext,
  limit = WORKER_BATCH_SIZE,
): Promise<string[]> {
  const rows = await ctx.tx
    .select({ id: questions.id })
    .from(questions)
    .where(and(eq(questions.status, 'queued'), gt(questions.expiresAt, ctx.time.now())))
    .orderBy(asc(questions.createdAt), asc(questions.id))
    .limit(limit);
  return rows.map((row) => row.id);
}

/**
 * Tries to hand one queued question to a suitable receiver (rule 6), for example somebody whose
 * cooldown has just ended. The question is locked with `SKIP LOCKED`, so a parallel command that
 * is already working with it (another worker, a user who just came online) is not disturbed.
 * Returns `true` when the question was assigned.
 */
export async function dispatchQueuedQuestion(
  ctx: CommandContext,
  questionId: string,
): Promise<boolean> {
  const { tx, time } = ctx;
  const [question] = await tx
    .select({ id: questions.id, text: questions.text, authorId: questions.authorId })
    .from(questions)
    .where(
      and(
        eq(questions.id, questionId),
        eq(questions.status, 'queued'),
        gt(questions.expiresAt, time.now()),
      ),
    )
    .for('no key update', { skipLocked: true });
  if (!question) return false;

  const receiverId = await findReceiver(ctx, question);
  if (receiverId === undefined) return false;
  await assignQuestion(ctx, question, receiverId);
  return true;
}

/**
 * Worker step 4: goes through the queue from the oldest question and assigns what can be
 * assigned now, in particular to users whose cooldown has ended. Returns how many questions
 * were assigned.
 */
export async function processQueue(core: Core): Promise<number> {
  return forEachRecord(core, findQueuedQuestionIds, dispatchQueuedQuestion);
}

/** How long delivered events stay in the outbox before the worker deletes them. */
export const OUTBOX_RETENTION_SECONDS = 7 * 24 * 60 * 60;

/**
 * Deletes delivered outbox events older than `retentionSeconds` (at most `limit` per call), so
 * the table, which holds copies of question and answer texts, does not grow forever. Events that
 * are not delivered yet are never deleted. Returns how many rows were removed.
 */
export async function purgeOutbox(
  core: Core,
  retentionSeconds = OUTBOX_RETENTION_SECONDS,
  limit = 1000,
): Promise<number> {
  const result = await core.run(async (ctx) => {
    const old = ctx.tx
      .select({ id: outbox.id })
      .from(outbox)
      .where(
        and(
          isNotNull(outbox.deliveredAt),
          lt(
            outbox.deliveredAt,
            sql`${ctx.time.now()} - ${retentionSeconds} * interval '1 second'`,
          ),
        ),
      )
      .limit(limit);
    const deleted = await ctx.tx
      .delete(outbox)
      .where(sql`${outbox.id} IN (${old})`)
      .returning({ id: outbox.id });
    return ok(deleted.length);
  });
  return result.ok ? result.value : 0;
}
