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
  logout: 'Выйти',
  home: {
    title: 'Бэкофис',
    welcome: 'Вы вошли. Разделы появятся в меню слева.',
  },
  errors: {
    invalid_credentials: 'Неверный логин или пароль',
    too_many_attempts: 'Слишком много попыток входа, попробуйте позже',
    backoffice_disabled: 'Бэкофис не настроен на сервере',
    invalid_request: 'Некорректный запрос',
    unauthorized: 'Требуется вход',
    network: 'Не удалось связаться с сервером',
    unknown: 'Что-то пошло не так',
  },
} as const;

export type ErrorCode = keyof typeof texts.errors;

/** Text for a reason code the server sent; unknown codes get the generic message. */
export const errorText = (code: string): string =>
  (texts.errors as Record<string, string>)[code] ?? texts.errors.unknown;
