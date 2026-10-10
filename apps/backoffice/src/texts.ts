/**
 * Interface texts. The back office is for the team, not for users, so it has one language
 * (the user-facing catalogue with `ru` and `en` is in `packages/shared/src/texts`).
 */
export const texts = {
  appName: 'human-msg · бэкофис',
  login: {
    title: 'Вход в бэкофис',
    login: 'Логин',
    password: 'Пароль',
    submit: 'Войти',
    required: 'Обязательное поле',
    failed: 'Вход не выполнен',
  },
  channels: { web: 'Веб', telegram: 'Telegram' },
  yes: 'да',
  no: 'нет',
  any: 'Все',
  users: {
    menu: 'Пользователи',
    title: 'Пользователи',
    alias: 'Псевдоним',
    channel: 'Канал',
    locale: 'Язык',
    kind: 'Тип',
    live: 'Живой',
    test: 'Тестовый',
    staff: 'Служебный',
    receiving: 'Получает вопросы',
    receivingOff: 'не беспокоить',
    botBlocked: 'бот заблокирован',
    asked: 'Вопросов',
    answered: 'Ответов',
    lastSeen: 'Был в сети',
    createdAt: 'Регистрация',
    createdRange: 'Дата регистрации',
    search: 'Поиск по псевдониму',
    find: 'Найти',
    reset: 'Сбросить',
    open: 'Открыть',
    card: 'Пользователь',
    telegramId: 'Telegram id',
    cooldownUntil: 'Пауза до',
    missedDeadlines: 'Пропущено дедлайнов подряд',
    id: 'id',
  },
  history: {
    title: 'Переписка',
    empty: 'Пользователь ещё ничего не спрашивал и не отвечал',
    more: 'Показать ещё',
    asked: 'Спросил(а)',
    answeredTo: 'Ответил(а) на вопрос',
    questionOf: 'Вопрос от',
    answerFrom: 'Ответ от',
    noAnswer: 'Ответа нет',
  },
  questionStatus: {
    queued: 'в очереди',
    assigned: 'назначен',
    answered: 'отвечен',
    expired: 'без ответа',
  },
  errors: {
    invalid_credentials: 'Неверный логин или пароль',
    too_many_attempts: 'Слишком много попыток входа, попробуйте позже',
    backoffice_disabled: 'Бэкофис не настроен на сервере',
    invalid_request: 'Некорректный запрос',
    not_found: 'Не найдено',
    unauthorized: 'Требуется вход',
    network: 'Не удалось связаться с сервером',
    unknown: 'Что-то пошло не так',
  },
} as const;

/** Text for a reason code the server sent; unknown codes get the generic message. */
export const errorText = (code: string): string =>
  (texts.errors as Record<string, string>)[code] ?? texts.errors.unknown;
