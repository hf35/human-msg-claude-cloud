import { assignments } from '@human-msg/db';
import { and, asc, eq, gt, isNull, lte, sql } from 'drizzle-orm';
import type { Core } from './core';
import { lockUser } from './matching';
import { emit } from './outbox';
import { releaseAssignment } from './questions';
import { ok } from './result';
import type { CommandContext } from './context';

/** How many records one worker step takes per pass. */
export const WORKER_BATCH_SIZE = 100;

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
  await releaseAssignment(ctx, assignment, 'timed_out', settings.COOLDOWN_SKIP);
  return true;
}

/**
 * Worker step 1: times out every assignment past its deadline. Each assignment is handled in
 * its own transaction, so one failure does not hold the others back. Returns how many were
 * timed out.
 */
export async function processDeadlines(core: Core): Promise<number> {
  const due = await core.run(async (ctx) => ok(await findDueAssignmentIds(ctx)));
  if (!due.ok) return 0;
  let done = 0;
  for (const id of due.value) {
    const result = await core.run(async (ctx) => ok(await timeOutAssignment(ctx, id)));
    if (result.ok && result.value) done++;
  }
  return done;
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
  const due = await core.run(async (ctx) => ok(await findReminderAssignmentIds(ctx)));
  if (!due.ok) return 0;
  let done = 0;
  for (const id of due.value) {
    const result = await core.run(async (ctx) => ok(await remindAssignment(ctx, id)));
    if (result.ok && result.value) done++;
  }
  return done;
}
