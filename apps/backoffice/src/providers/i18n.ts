import type { I18nProvider } from '@refinedev/core';

/**
 * Russian for the stock phrases of Refine's components; anything else falls back to Refine's own
 * text.
 */
const phrases: Record<string, string> = {
  'buttons.logout': 'Выйти',
  'buttons.refresh': 'Обновить',
  'buttons.save': 'Сохранить',
  'buttons.cancel': 'Отмена',
  'buttons.show': 'Открыть',
  'actions.show': 'Карточка',
  'actions.list': 'Список',
  'buttons.filter': 'Фильтр',
  'buttons.clear': 'Сбросить',
  'table.actions': 'Действия',
  'notifications.success': 'Готово',
  'notifications.error': 'Ошибка',
  loading: 'Загрузка…',
};

export const i18nProvider: I18nProvider = {
  // Refine calls both `translate(key, options, default)` and `translate(key, default)`
  translate: (key: string, options?: unknown, defaultMessage?: string) =>
    phrases[key] ?? defaultMessage ?? (typeof options === 'string' ? options : key),
  changeLocale: async () => undefined,
  getLocale: () => 'ru',
};
