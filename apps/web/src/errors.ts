import type { MeResponse, Texts } from '@human-msg/shared';
import { ApiError } from './api';

/**
 * The text for a refused or failed `POST /api/messages`: the reason code of the server becomes a
 * sentence in the user's language (the same sentences the Telegram bot uses).
 */
export function describeSendError(
  error: unknown,
  t: Texts,
  me: Pick<MeResponse, 'questionLimit' | 'messageMaxLength'>,
): string {
  if (!(error instanceof ApiError)) return t.errors.generic;
  switch (error.code) {
    case 'network':
      return t.web.errors.network;
    case 'empty':
      return t.rejections.messageEmpty;
    case 'tooShort':
      return t.rejections.messageTooShort;
    case 'tooLong':
      return t.rejections.messageTooLong(me.messageMaxLength);
    case 'notText':
      return t.rejections.onlyText;
    case 'awaitingAnswer':
      return t.rejections.awaitingAnswer;
    case 'dailyLimit':
      return t.rejections.dailyLimitReached(me.questionLimit.limit);
    default:
      return t.errors.generic;
  }
}
