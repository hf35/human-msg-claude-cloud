import { en } from './en';
import { ru } from './ru';

export const LOCALES = ['ru', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'ru';

/** Shape of the catalogue. It is derived from `ru`, so a missing key in any locale is a type error. */
export type Texts = typeof ru;

const catalogue: Record<Locale, Texts> = { ru, en };

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** Texts for a locale; an unknown or missing locale falls back to the default one. */
export function getTexts(locale?: string | null): Texts {
  return catalogue[isLocale(locale) ? locale : DEFAULT_LOCALE];
}
