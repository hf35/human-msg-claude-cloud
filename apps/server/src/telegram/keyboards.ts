import { getTexts, type Locale } from '@human-msg/shared';
import { InlineKeyboard } from 'grammy';

// Callback data is limited to 64 bytes; a UUID and a short prefix fit
export const SKIP_CALLBACK = /^skip:([0-9a-f-]{36})$/;
export const QUESTION_REPORT_CALLBACK = /^rq:([0-9a-f-]{36})$/;
export const ANSWER_REPORT_CALLBACK = /^ra:([0-9a-f-]{36})$/;

/** Under a question assigned to the person: skip it or complain about it. */
export const questionKeyboard = (locale: Locale, questionId: string) => {
  const t = getTexts(locale);
  return new InlineKeyboard()
    .text(t.buttons.skip, `skip:${questionId}`)
    .text(t.buttons.report, `rq:${questionId}`);
};

/** Under an answer the author received: complain about it. */
export const answerKeyboard = (locale: Locale, questionId: string) =>
  new InlineKeyboard().text(getTexts(locale).buttons.report, `ra:${questionId}`);
