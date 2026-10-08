import {
  answers,
  assignments,
  blocks,
  questions,
  users,
  type AssignmentOutcome,
  type Tx,
} from '@human-msg/db';
import { and, count, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { CommandContext } from './context';
import { findReceiver } from './matching';
import { emit } from './outbox';
import { fail, ok, type Result } from './result';

export type QuestionStatusAfterAsk = 'assigned' | 'queued';

export interface AskedQuestion {
  questionId: string;
  status: QuestionStatusAfterAsk;
}

/** Rule 2: whether the user has a question of their own that is waiting for an answer. */
export async function hasPendingQuestion(tx: Tx, userId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: questions.id })
    .from(questions)
    .where(and(eq(questions.authorId, userId), inArray(questions.status, ['queued', 'assigned'])))
    .limit(1);
  return rows.length > 0;
}

/** Rule 10: questions the user asked within the last 24 hours (a sliding window). */
export async function countRecentQuestions(ctx: CommandContext, userId: string): Promise<number> {
  const [row] = await ctx.tx
    .select({ total: count() })
    .from(questions)
    .where(
      and(
        eq(questions.authorId, userId),
        gt(questions.createdAt, sql`${ctx.time.now()} - interval '24 hours'`),
      ),
    );
  return row!.total;
}

/**
 * Hands a question to a receiver: creates the assignment with its deadline, moves the question
 * to `assigned` and tells the receiver. `ANSWER_TIMEOUT` is read now and stored in
 * `deadline_at`, so later setting changes do not move it. The receiver must already be locked by
 * `findReceiver` in the same transaction.
 */
export async function assignQuestion(
  ctx: CommandContext,
  question: { id: string; text: string; authorId: string },
  receiverId: string,
): Promise<void> {
  const { tx, time, settings } = ctx;
  const [assignment] = await tx
    .insert(assignments)
    .values({
      questionId: question.id,
      receiverId,
      assignedAt: time.now(),
      deadlineAt: sql`${time.now()} + ${settings.ANSWER_TIMEOUT} * interval '1 second'`,
    })
    .returning({ deadlineAt: assignments.deadlineAt });
  await tx.update(questions).set({ status: 'assigned' }).where(eq(questions.id, question.id));
  const [author] = await tx
    .select({ alias: users.alias })
    .from(users)
    .where(eq(users.id, question.authorId));
  await emit(tx, receiverId, {
    type: 'question.assigned',
    questionId: question.id,
    text: question.text,
    authorAlias: author!.alias,
    deadlineAt: assignment!.deadlineAt.toISOString(),
  });
}

/**
 * Creates a question and gives it to a random suitable receiver; if there is none, the question
 * waits in the queue (rule 5). `expires_at` is fixed here. The text must already be validated
 * (see `handleIncomingText`).
 *
 * Rule 2: refused with `awaiting_answer` while the author has a question that is still `queued`
 * or `assigned`. The partial unique index decides races between parallel sends.
 * Rule 10: refused with `daily_limit` after `QUESTIONS_PER_DAY` questions within 24 hours.
 * Answers never count and are never limited.
 */
export async function askQuestion(
  ctx: CommandContext,
  authorId: string,
  text: string,
): Promise<Result<AskedQuestion, 'user_not_found' | 'awaiting_answer' | 'daily_limit'>> {
  const { tx, time, settings } = ctx;
  const [author] = await tx.select({ id: users.id }).from(users).where(eq(users.id, authorId));
  if (!author) return fail('user_not_found');

  if (await hasPendingQuestion(tx, authorId)) return fail('awaiting_answer');
  if ((await countRecentQuestions(ctx, authorId)) >= settings.QUESTIONS_PER_DAY) {
    return fail('daily_limit');
  }

  // A parallel send by the same author passes the check above; the unique index then skips the
  // insert instead of failing the transaction
  const [question] = await tx
    .insert(questions)
    .values({
      authorId,
      text,
      createdAt: time.now(),
      expiresAt: sql`${time.now()} + ${settings.QUESTION_TTL} * interval '1 second'`,
    })
    .onConflictDoNothing()
    .returning();
  if (!question) return fail('awaiting_answer');

  const receiverId = await findReceiver(ctx, question);
  if (receiverId === undefined) {
    await emit(tx, authorId, { type: 'question.queued', questionId: question.id });
    return ok({ questionId: question.id, status: 'queued' });
  }
  await assignQuestion(ctx, question, receiverId);
  return ok({ questionId: question.id, status: 'assigned' });
}

/**
 * Saves the answer of a receiver to the question assigned to them (rules 1, 4, 9).
 *
 * The active assignment is locked first, so an answer racing with a timeout, a skip or a report
 * of the same assignment is either counted or refused, never both. In one transaction:
 * - the answer is stored as its own row linked to the question (rule 4);
 * - the question becomes `answered`, the assignment ends with outcome `answered`;
 * - the receiver's cooldown starts (`COOLDOWN_WEB` / `COOLDOWN_TELEGRAM`, by channel);
 * - the author gets the answer together with the text of the question.
 *
 * Nothing here looks at the answerer's own questions: an answer is always allowed (rule 1).
 * The text must already be validated (see `handleIncomingText`).
 */
export async function submitAnswer(
  ctx: CommandContext,
  userId: string,
  text: string,
): Promise<Result<{ questionId: string }, 'no_active_assignment'>> {
  const { tx, time, settings } = ctx;
  const [assignment] = await tx
    .select({ id: assignments.id, questionId: assignments.questionId })
    .from(assignments)
    .where(and(eq(assignments.receiverId, userId), isNull(assignments.outcome)))
    .for('update');
  if (!assignment) return fail('no_active_assignment');

  const [responder] = await tx
    .select({ alias: users.alias, channel: users.channel })
    .from(users)
    .where(eq(users.id, userId));
  const [question] = await tx
    .update(questions)
    .set({ status: 'answered', answeredAt: time.now() })
    .where(eq(questions.id, assignment.questionId))
    .returning({ authorId: questions.authorId, text: questions.text });

  await tx.insert(answers).values({
    questionId: assignment.questionId,
    authorId: userId,
    text,
    createdAt: time.now(),
  });
  await tx
    .update(assignments)
    .set({ outcome: 'answered', endedAt: time.now() })
    .where(eq(assignments.id, assignment.id));

  const cooldown =
    responder!.channel === 'web' ? settings.COOLDOWN_WEB : settings.COOLDOWN_TELEGRAM;
  await tx
    .update(users)
    .set({ cooldownUntil: sql`${time.now()} + ${cooldown} * interval '1 second'` })
    .where(eq(users.id, userId));

  await emit(tx, question!.authorId, {
    type: 'answer.received',
    questionId: assignment.questionId,
    questionText: question!.text,
    answerText: text,
    responderAlias: responder!.alias,
  });
  return ok({ questionId: assignment.questionId });
}

/**
 * Puts a question back into the queue and immediately tries to hand it to another receiver
 * (rules 5 and 6). An expired question is not handed out (`expires_at` is checked now); it
 * stays queued until the worker marks it `expired`.
 */
export async function requeueQuestion(ctx: CommandContext, questionId: string): Promise<void> {
  const { tx, time } = ctx;
  const [question] = await tx
    .update(questions)
    .set({ status: 'queued' })
    .where(eq(questions.id, questionId))
    .returning();
  const [alive] = await tx
    .select({ alive: sql<boolean>`${question!.expiresAt} > ${time.now()}` })
    .from(questions)
    .where(eq(questions.id, questionId));
  if (!alive!.alive) return;
  const receiverId = await findReceiver(ctx, question!);
  if (receiverId !== undefined) await assignQuestion(ctx, question!, receiverId);
}

/**
 * Ends an active assignment without an answer: records the outcome, optionally starts the
 * receiver's cooldown, and sends the question on (`requeueQuestion`).
 */
export async function releaseAssignment(
  ctx: CommandContext,
  assignment: { id: string; questionId: string; receiverId: string },
  outcome: Exclude<AssignmentOutcome, 'answered'>,
  cooldownSeconds: number | null,
): Promise<void> {
  const { tx, time } = ctx;
  await tx
    .update(assignments)
    .set({ outcome, endedAt: time.now() })
    .where(eq(assignments.id, assignment.id));
  if (cooldownSeconds !== null) {
    await tx
      .update(users)
      .set({ cooldownUntil: sql`${time.now()} + ${cooldownSeconds} * interval '1 second'` })
      .where(eq(users.id, assignment.receiverId));
  }
  await requeueQuestion(ctx, assignment.questionId);
}

/**
 * Rule 8: the receiver declines the question assigned to them. The assignment ends as
 * `skipped` (kept in the history, so they never get this question again), the receiver rests
 * for `COOLDOWN_SKIP`, and the question goes to someone else right away or back to the queue.
 */
export async function skipAssignment(
  ctx: CommandContext,
  userId: string,
): Promise<Result<{ questionId: string }, 'no_active_assignment'>> {
  const [assignment] = await ctx.tx
    .select({
      id: assignments.id,
      questionId: assignments.questionId,
      receiverId: assignments.receiverId,
    })
    .from(assignments)
    .where(and(eq(assignments.receiverId, userId), isNull(assignments.outcome)))
    .for('update');
  if (!assignment) return fail('no_active_assignment');
  await releaseAssignment(ctx, assignment, 'skipped', ctx.settings.COOLDOWN_SKIP);
  return ok({ questionId: assignment.questionId });
}

/**
 * Records the one-way exclusion made by a complaint: questions of `authorId` are never assigned
 * to `receiverId` again. Complaining twice about the same pair changes nothing.
 */
async function addBlock(
  ctx: CommandContext,
  block: { authorId: string; receiverId: string; reportedBy: string; questionId: string },
): Promise<void> {
  await ctx.tx.insert(blocks).values(block).onConflictDoNothing();
}

/**
 * The author complains about the answer to their question: its responder will never answer
 * this author again. Nobody else is affected, and the responder's own questions still reach
 * the author.
 */
export async function reportAnswer(
  ctx: CommandContext,
  authorId: string,
  questionId: string,
): Promise<Result<void, 'not_found' | 'not_answered'>> {
  const [row] = await ctx.tx
    .select({ responderId: answers.authorId })
    .from(questions)
    .leftJoin(answers, eq(answers.questionId, questions.id))
    .where(and(eq(questions.id, questionId), eq(questions.authorId, authorId)));
  if (!row) return fail('not_found');
  if (row.responderId === null) return fail('not_answered');
  await addBlock(ctx, {
    authorId,
    receiverId: row.responderId,
    reportedBy: authorId,
    questionId,
  });
  return ok();
}

/**
 * The receiver complains about the question assigned to them. The assignment ends as `reported`
 * right away and without a cooldown, the question goes on to someone else (or back to the
 * queue), and the receiver never gets questions of this author again.
 */
export async function reportQuestion(
  ctx: CommandContext,
  userId: string,
): Promise<Result<{ questionId: string }, 'no_active_assignment'>> {
  const [assignment] = await ctx.tx
    .select({
      id: assignments.id,
      questionId: assignments.questionId,
      receiverId: assignments.receiverId,
      authorId: questions.authorId,
    })
    .from(assignments)
    .innerJoin(questions, eq(questions.id, assignments.questionId))
    .where(and(eq(assignments.receiverId, userId), isNull(assignments.outcome)))
    .for('update', { of: assignments });
  if (!assignment) return fail('no_active_assignment');
  await addBlock(ctx, {
    authorId: assignment.authorId,
    receiverId: userId,
    reportedBy: userId,
    questionId: assignment.questionId,
  });
  await releaseAssignment(ctx, assignment, 'reported', null);
  return ok({ questionId: assignment.questionId });
}
