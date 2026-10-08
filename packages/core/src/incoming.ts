import { validateMessageText, type MessageRejectionReason } from '@human-msg/shared';
import type { CommandContext } from './context';
import { emit } from './outbox';
import { askQuestion, submitAnswer, type QuestionStatusAfterAsk } from './questions';
import { fail, ok, type Result } from './result';

export type IncomingOutcome =
  | { kind: 'answered'; questionId: string }
  | { kind: 'asked'; questionId: string; status: QuestionStatusAfterAsk };

/**
 * Entry point for every message a user sends, in the order that matters (CLAUDE.md):
 * 0. not text, empty, too short or too long → refused;
 * 1. the user has a question assigned → it is an answer (rule 1), whatever else they are doing;
 * 2. the user waits for an answer to their own question → refused (rule 2);
 * 3. the daily limit is used up → refused (rule 10);
 * 4. otherwise it is a new question: assigned to a receiver or queued.
 *
 * Checking "is it an answer?" before the rules that limit questions is what keeps rules 2, 3
 * and 10 from blocking an answer. A refusal also sends the user a `message.rejected` event.
 *
 * @param text The message text, or `null` for anything that is not text (photo, sticker, ...).
 */
export async function handleIncomingText(
  ctx: CommandContext,
  userId: string,
  text: string | null,
): Promise<Result<IncomingOutcome, MessageRejectionReason | 'user_not_found'>> {
  const refuse = async (reason: MessageRejectionReason) => {
    await emit(ctx.tx, userId, { type: 'message.rejected', reason });
    return fail(reason);
  };

  if (text === null) return refuse('notText');
  const checked = validateMessageText(text, ctx.settings.MESSAGE_MAX_LENGTH);
  if (!checked.ok) return refuse(checked.reason);

  const answered = await submitAnswer(ctx, userId, checked.text);
  if (answered.ok) return ok({ kind: 'answered', questionId: answered.value.questionId });

  const asked = await askQuestion(ctx, userId, checked.text);
  if (asked.ok) return ok({ kind: 'asked', ...asked.value });
  return asked.reason === 'user_not_found'
    ? fail(asked.reason)
    : refuse(asked.reason === 'awaiting_answer' ? 'awaitingAnswer' : 'dailyLimit');
}
