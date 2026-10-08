import { answers, questions, users } from '@human-msg/db';
import { validateMessageText, type MessageRejection } from '@human-msg/shared';
import { eq } from 'drizzle-orm';
import type { CommandContext } from './context';
import { emit } from './outbox';
import { fail, ok, type Result } from './result';
import { createStaffUser } from './users';

/**
 * Answers a question that expired unanswered, from the back office. The answer is an ordinary
 * `answers` row (rule 4) written on behalf of a new staff user with a random alias in the
 * author's language, and the author gets `answer.received` like for any other answer: nothing
 * marks it as an answer of the team. This does not send anything to a chosen person, it only
 * answers a question that was already asked.
 *
 * Refused unless the question is `expired`; the question row is locked, so two staff answers (or
 * a staff answer racing with another change) cannot both succeed.
 */
export async function staffAnswer(
  ctx: CommandContext,
  questionId: string,
  text: string,
): Promise<Result<{ responderId: string }, 'not_found' | 'not_expired' | MessageRejection>> {
  const { tx, time, settings } = ctx;
  const checked = validateMessageText(text, settings.MESSAGE_MAX_LENGTH);
  if (!checked.ok) return fail(checked.reason);

  const [question] = await tx
    .select()
    .from(questions)
    .where(eq(questions.id, questionId))
    .for('no key update');
  if (!question) return fail('not_found');
  if (question.status !== 'expired') return fail('not_expired');

  const [author] = await tx
    .select({ locale: users.locale })
    .from(users)
    .where(eq(users.id, question.authorId));
  const responder = await createStaffUser(tx, { locale: author!.locale });

  await tx.insert(answers).values({
    questionId,
    authorId: responder.id,
    text: checked.text,
    createdAt: time.now(),
  });
  await tx
    .update(questions)
    .set({ status: 'answered', answeredAt: time.now() })
    .where(eq(questions.id, questionId));
  await emit(tx, question.authorId, {
    type: 'answer.received',
    questionId,
    questionText: question.text,
    answerText: checked.text,
    responderAlias: responder.alias,
  });
  return ok({ responderId: responder.id });
}
