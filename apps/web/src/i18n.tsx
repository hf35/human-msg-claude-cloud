import { DEFAULT_LOCALE, getTexts, isLocale, type Locale, type Texts } from '@human-msg/shared';
import { createContext, useContext, type ReactNode } from 'react';

const STORAGE_KEY = 'locale';

/**
 * The interface language for a browser's list of preferred languages: the first one we speak.
 * A browser that prefers neither Russian nor English gets the default language.
 */
export function detectLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const primary = language.toLowerCase().split('-')[0];
    if (isLocale(primary)) return primary;
  }
  return DEFAULT_LOCALE;
}

/** The language chosen before signing in; storage can be blocked, which is not an error. */
export function readStoredLocale(): Locale | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isLocale(value) ? value : null;
  } catch {
    return null;
  }
}

export function storeLocale(locale: Locale): void {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // Without storage the choice lasts until the page is closed
  }
}

/** Before sign-in: what the user chose last time, otherwise what the browser prefers. */
export function initialLocale(): Locale {
  return readStoredLocale() ?? detectLocale(navigator.languages ?? [navigator.language]);
}

interface I18n {
  locale: Locale;
  t: Texts;
  setLocale(locale: Locale): void;
}

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ value, children }: { value: I18n; children: ReactNode }) {
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside I18nProvider');
  return value;
}

export const textsFor = (locale: Locale): Texts => getTexts(locale);
