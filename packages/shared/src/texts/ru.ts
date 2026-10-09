// Source of truth for the shape of the catalogue: every other locale must match it.
// Texts with parameters are functions, so that each language controls its own grammar.
export const ru = {
  buttons: {
    skip: 'Пропустить',
    report: 'Пожаловаться',
  },

  // Answers to a message the user is not allowed to send
  rejections: {
    awaitingAnswer: 'Вы уже задали вопрос — дождитесь ответа, прежде чем задавать следующий.',
    dailyLimitReached: (limit: number) =>
      `Вы достигли лимита вопросов на сегодня (${limit}). Попробуйте позже.`,
    messageEmpty: 'Сообщение пустое. Напишите что-нибудь.',
    messageTooShort: 'Сообщение слишком короткое. Напишите хотя бы пару слов.',
    messageTooLong: (maxLength: number) =>
      `Сообщение слишком длинное. Максимум — ${maxLength} символов.`,
    onlyText: 'Пока поддерживается только текст.',
    answerTimeExpired: 'Время на ответ истекло: вопрос уже передан другому человеку.',
  },

  // Notifications about the life of a question
  notifications: {
    questionQueued: 'Ищем, кто ответит на ваш вопрос…',
    questionAssigned: (alias: string, minutes: number) =>
      `Вам пришёл вопрос от «${alias}». Ответьте в течение ${minutes} мин. или нажмите «Пропустить».`,
    answerReceived: (alias: string) => `Ответ от «${alias}»`,
    questionAndAnswer: (question: string, answer: string) =>
      `Ваш вопрос:\n${question}\n\nОтвет:\n${answer}`,
    answerReminder: (minutes: number) =>
      `Осталось около ${minutes} мин. — ответьте на вопрос или пропустите его.`,
    assignmentExpired: 'Время на ответ истекло, вопрос передан другому человеку.',
    questionExpired:
      'К сожалению, никто не успел ответить на ваш вопрос. Вы можете задать его ещё раз.',
    autoDoNotDisturb: (count: number) =>
      `Вы не ответили на вопросы ${count} раза подряд, поэтому мы выключили получение чужих вопросов. Чтобы вернуться, отправьте /resume.`,
    skipped: 'Вопрос пропущен.',
    reported: 'Жалоба принята. Вы больше не будете получать вопросы от этого человека.',
  },

  // Telegram bot commands
  bot: {
    start: (alias: string) =>
      `Привет! Здесь можно задать вопрос живому человеку или ответить на чужой. Ваше имя здесь — «${alias}».\n\nПросто напишите вопрос, и он уйдёт случайному собеседнику.`,
    help: 'Напишите вопрос — он уйдёт случайному человеку, и вы получите ответ. Если вам пришёл чужой вопрос, ответьте на него обычным сообщением или нажмите «Пропустить».\n\n/stop — не получать чужие вопросы\n/resume — снова получать',
    stopped: 'Хорошо, чужие вопросы больше не приходят. Чтобы вернуться, отправьте /resume.',
    resumed: 'Снова на связи — чужие вопросы будут приходить.',
  },

  errors: {
    generic: 'Что-то пошло не так. Попробуйте ещё раз чуть позже.',
  },
};
