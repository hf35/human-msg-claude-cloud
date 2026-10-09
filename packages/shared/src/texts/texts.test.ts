import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, LOCALES, getTexts, isLocale } from './index';

// Flattens the catalogue into "path -> value", calling text functions with sample arguments
function flatten(node: unknown, path = ''): Record<string, string> {
  if (typeof node === 'string') return { [path]: node };
  if (typeof node === 'function') {
    // Sample arguments make sure every parameter shows up in the output
    return { [path]: (node as (...args: unknown[]) => string)('ALIAS-7', 'ALIAS-7') };
  }
  return Object.entries(node as Record<string, unknown>).reduce(
    (acc, [key, value]) => ({ ...acc, ...flatten(value, path ? `${path}.${key}` : key) }),
    {},
  );
}

const CYRILLIC = /[А-Яа-яЁё]/;

describe('texts', () => {
  it('supports Russian and English, Russian by default', () => {
    expect(LOCALES).toEqual(['ru', 'en']);
    expect(DEFAULT_LOCALE).toBe('ru');
  });

  it('has the same keys in every locale', () => {
    const [first, ...rest] = LOCALES.map((locale) => Object.keys(flatten(getTexts(locale))).sort());
    for (const keys of rest) expect(keys).toEqual(first);
  });

  it('has no empty texts', () => {
    for (const locale of LOCALES) {
      for (const [path, text] of Object.entries(flatten(getTexts(locale)))) {
        expect(text.trim(), `${locale}: ${path}`).not.toBe('');
      }
    }
  });

  it('keeps the languages apart: Cyrillic only in Russian', () => {
    for (const [path, text] of Object.entries(flatten(getTexts('ru')))) {
      expect(text, `ru: ${path}`).toMatch(CYRILLIC);
    }
    for (const [path, text] of Object.entries(flatten(getTexts('en')))) {
      expect(text, `en: ${path}`).not.toMatch(CYRILLIC);
    }
  });

  it('puts the parameters into the text', () => {
    for (const locale of LOCALES) {
      const t = getTexts(locale);
      expect(t.rejections.dailyLimitReached(10)).toContain('10');
      expect(t.rejections.messageTooLong(2000)).toContain('2000');
      expect(t.notifications.questionAssigned('Green Rabbit', 30)).toContain('Green Rabbit');
      expect(t.notifications.questionAssigned('Green Rabbit', 30)).toContain('30');
      expect(t.notifications.answerReceived('Green Rabbit')).toContain('Green Rabbit');
      expect(t.notifications.answerReminder(5)).toContain('5');
      expect(t.bot.start('Green Rabbit')).toContain('Green Rabbit');
      expect(t.web.header.signedInAs('Green Rabbit')).toContain('Green Rabbit');
      const both = t.notifications.questionAndAnswer('QQQ', 'AAA');
      expect(both).toContain('QQQ');
      expect(both).toContain('AAA');
    }
  });

  describe('getTexts', () => {
    it('returns the texts of the requested locale', () => {
      expect(getTexts('en').buttons.skip).toBe('Skip');
      expect(getTexts('ru').buttons.skip).toBe('Пропустить');
    });

    it('falls back to the default locale', () => {
      expect(getTexts()).toBe(getTexts(DEFAULT_LOCALE));
      expect(getTexts(null)).toBe(getTexts(DEFAULT_LOCALE));
      expect(getTexts('de')).toBe(getTexts(DEFAULT_LOCALE));
    });
  });

  it('recognises locales', () => {
    expect(isLocale('en')).toBe(true);
    expect(isLocale('ru')).toBe(true);
    expect(isLocale('de')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });
});
