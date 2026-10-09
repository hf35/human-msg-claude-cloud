import { getTexts } from '@human-msg/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { describeSendError } from './errors';

const me = { questionLimit: { limit: 10, used: 10, remaining: 0 }, messageMaxLength: 2000 };

describe('describeSendError', () => {
  it.each([
    ['empty', 'Сообщение пустое. Напишите что-нибудь.'],
    ['tooShort', 'Сообщение слишком короткое. Напишите хотя бы пару слов.'],
    ['tooLong', 'Сообщение слишком длинное. Максимум — 2000 символов.'],
    ['notText', 'Пока поддерживается только текст.'],
    ['awaitingAnswer', 'Вы уже задали вопрос — дождитесь ответа, прежде чем задавать следующий.'],
    ['dailyLimit', 'Вы достигли лимита вопросов на сегодня (10). Попробуйте позже.'],
    ['network', 'Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.'],
    ['something_new', 'Что-то пошло не так. Попробуйте ещё раз чуть позже.'],
  ])('%s', (code, expected) => {
    expect(describeSendError(new ApiError(400, code), getTexts('ru'), me)).toBe(expected);
  });

  it('speaks the language it is given', () => {
    expect(describeSendError(new ApiError(429, 'dailyLimit'), getTexts('en'), me)).toBe(
      "You have reached today's question limit (10). Please try again later.",
    );
  });

  it('does not expose unexpected errors', () => {
    expect(describeSendError(new Error('secret'), getTexts('en'), me)).toBe(
      getTexts('en').errors.generic,
    );
  });
});
