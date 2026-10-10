import type { I18nProvider } from '@refinedev/core';

/** Russian for the few stock phrases of Refine's layout; everything else falls back to Refine's own text. */
const phrases: Record<string, string> = {
  'buttons.logout': 'Выйти',
  'buttons.refresh': 'Обновить',
  'buttons.save': 'Сохранить',
  'buttons.cancel': 'Отмена',
  'buttons.show': 'Открыть',
  'buttons.filter': 'Фильтр',
  'buttons.clear': 'Сбросить',
  'table.actions': 'Действия',
  'notifications.success': 'Готово',
  'notifications.error': 'Ошибка',
  loading: 'Загрузка…',
};

export const i18nProvider: I18nProvider = {
  translate: (key, _options, defaultMessage) => phrases[key] ?? defaultMessage ?? key,
  changeLocale: async () => undefined,
  getLocale: () => 'ru',
};
