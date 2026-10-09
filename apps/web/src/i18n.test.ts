import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectLocale, initialLocale, readStoredLocale, storeLocale } from './i18n';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('detectLocale', () => {
  it.each([
    [['ru-RU', 'en'], 'ru'],
    [['en-US', 'ru'], 'en'],
    [['de-DE', 'ru'], 'ru'],
    [['RU'], 'ru'],
    [['de', 'fr'], 'ru'],
    [[], 'ru'],
  ])('%j → %s', (languages, expected) => {
    expect(detectLocale(languages)).toBe(expected);
  });
});

describe('stored language', () => {
  it('is remembered and wins over the browser', () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['ru-RU']);
    expect(initialLocale()).toBe('ru');
    storeLocale('en');
    expect(readStoredLocale()).toBe('en');
    expect(initialLocale()).toBe('en');
  });

  it('ignores garbage in the storage', () => {
    localStorage.setItem('locale', 'klingon');
    expect(readStoredLocale()).toBeNull();
  });

  it('survives storage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readStoredLocale()).toBeNull();
    expect(() => storeLocale('en')).not.toThrow();
  });
});
