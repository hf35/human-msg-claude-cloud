import { assignments, questions, users } from '@human-msg/db';
import { eq, sql } from 'drizzle-orm';
import type { CommandContext } from './context';
import { findReceiver } from './matching';
import { emit } from './outbox';
import { fail, ok, type Result } from './result';

export type QuestionStatusAfterAsk = 'assigned' | 'queued';

export interface AskedQuestion {
  questionId: string;
  status: QuestionStatusAfterAsk;
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
 */
export async function askQuestion(
  ctx: CommandContext,
  authorId: string,
  text: string,
): Promise<Result<AskedQuestion, 'user_not_found'>> {
  const { tx, time, settings } = ctx;
  const [author] = await tx.select({ id: users.id }).from(users).where(eq(users.id, authorId));
  if (!author) return fail('user_not_found');

  const [question] = await tx
    .insert(questions)
    .values({
      authorId,
      text,
      createdAt: time.now(),
      expiresAt: sql`${time.now()} + ${settings.QUESTION_TTL} * interval '1 second'`,
    })
    .returning();

  const receiverId = await findReceiver(ctx, question!);
  if (receiverId === undefined) {
    await emit(tx, authorId, { type: 'question.queued', questionId: question!.id });
    return ok({ questionId: question!.id, status: 'queued' });
  }
  await assignQuestion(ctx, question!, receiverId);
  return ok({ questionId: question!.id, status: 'assigned' });
}
