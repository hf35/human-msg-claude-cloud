import { DEFAULT_LOCALE, isLocale, type Locale } from '../texts';
import { enAdjectives, enAnimals, ruAdjectives, ruAnimals } from './words';

/** Returns a number in [0, 1), like `Math.random`. Injectable to make tests deterministic. */
export type RandomSource = () => number;

function pick<T>(list: readonly T[], random: RandomSource): T {
  // Math.min guards against a source that returns exactly 1
  const item = list[Math.min(Math.floor(random() * list.length), list.length - 1)];
  if (item === undefined) throw new Error('Cannot pick from an empty list');
  return item;
}

function ruAlias(random: RandomSource): string {
  return `${pick(ruAdjectives, random)} ${pick(ruAnimals, random)}`;
}

function enAlias(random: RandomSource): string {
  return `${pick(enAdjectives, random)} ${pick(enAnimals, random)}`;
}

/**
 * A random anonymous alias in the given language, e.g. "Зелёный Кролик" or "Green Rabbit".
 * Aliases are cosmetic and are not guaranteed to be unique.
 * An unknown or missing locale falls back to the default one.
 */
export function randomAlias(
  locale?: Locale | string | null,
  random: RandomSource = Math.random,
): string {
  const resolved = isLocale(locale) ? locale : DEFAULT_LOCALE;
  return resolved === 'ru' ? ruAlias(random) : enAlias(random);
}
