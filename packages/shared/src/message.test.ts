import { describe, expect, it } from 'vitest';
import { MIN_MESSAGE_LENGTH, validateMessageText } from './message';

const MAX = 2000;

function check(text: string, maxLength = MAX) {
  return validateMessageText(text, maxLength);
}

function rejection(text: string, maxLength = MAX) {
  const result = check(text, maxLength);
  return result.ok ? 'ok' : result.reason;
}

describe('validateMessageText', () => {
  describe('empty text', () => {
    it.each([
      ['an empty string', ''],
      ['spaces', '     '],
      ['tabs and newlines', ' \t\n\r\n '],
      ['non-breaking and ideographic spaces', '\u00A0\u3000\u2003'],
      ['zero-width characters', '\u200B\u200C\u200D\uFEFF\u2060'],
      ['bidi marks and a soft hyphen', '\u200E\u200F\u00AD'],
      ['Hangul fillers', '\u3164\uFFA0\u115F\u1160'],
      ['invisible tag characters outside the BMP', '\u{E0001}\u{E0020}'],
      ['control characters only', '\u0000\u0001\u0007\u007F'],
      ['a very long run of spaces', ' '.repeat(1_000_000)],
    ])('rejects %s', (_name, text) => {
      expect(rejection(text)).toBe('empty');
    });
  });

  describe('too short', () => {
    it.each([
      ['one letter', 'a'],
      ['one Cyrillic letter', 'я'],
      ['one letter with spaces around it', '   a \n'],
      ['one emoji', '👍'],
      ['one emoji with a skin tone', '👍🏽'],
      ['one family emoji built from several code points', '👨\u200D👩\u200D👧'],
      ['a letter with a combining accent', 'é'],
      ['one symbol among invisible characters', '\u200B?\u200B'],
    ])('rejects %s', (_name, text) => {
      expect(rejection(text)).toBe('tooShort');
    });

    it('accepts exactly the minimum length', () => {
      expect(MIN_MESSAGE_LENGTH).toBe(2);
      expect(rejection('ab')).toBe('ok');
      expect(rejection('👍👍')).toBe('ok');
      expect(rejection('?!')).toBe('ok');
    });
  });

  describe('too long', () => {
    it('accepts exactly the maximum length and rejects one more', () => {
      expect(rejection('a'.repeat(MAX))).toBe('ok');
      expect(rejection('a'.repeat(MAX + 1))).toBe('tooLong');
    });

    it('counts characters as the user sees them', () => {
      // Each family emoji is one character, although it is 8 UTF-16 code units
      expect(rejection('👨\u200D👩\u200D👧'.repeat(MAX))).toBe('ok');
      expect(rejection('👨\u200D👩\u200D👧'.repeat(MAX + 1))).toBe('tooLong');
      // "e" + a combining accent is one character
      expect(rejection('é'.repeat(MAX))).toBe('ok');
      // Characters outside the Basic Multilingual Plane are one character too
      expect(rejection('𝒜'.repeat(MAX))).toBe('ok');
    });

    it('measures the text after trimming', () => {
      expect(rejection(`  ${'a'.repeat(MAX)}  `)).toBe('ok');
    });

    it('rejects a huge text and one character with endless combining marks', () => {
      expect(rejection('a'.repeat(1_000_000))).toBe('tooLong');
      expect(rejection(`a${'́'.repeat(100_000)}`)).toBe('tooLong');
    });

    it('uses the given maximum', () => {
      expect(rejection('abcde', 5)).toBe('ok');
      expect(rejection('abcdef', 5)).toBe('tooLong');
    });
  });

  describe('cleaning', () => {
    it('trims spaces around the text', () => {
      expect(check('  Привет, мир \n')).toEqual({ ok: true, text: 'Привет, мир' });
    });

    it('keeps line breaks and spaces inside the text', () => {
      expect(check('first line\n\nsecond  line')).toEqual({
        ok: true,
        text: 'first line\n\nsecond  line',
      });
    });

    it('turns Windows and old Mac line endings into \\n', () => {
      expect(check('one\r\ntwo\rthree')).toEqual({ ok: true, text: 'one\ntwo\nthree' });
    });

    it('drops control characters, in particular NUL', () => {
      expect(check('a\u0000b\u0007c\u007Fd')).toEqual({ ok: true, text: 'abcd' });
    });

    it('keeps tabs, emoji and other scripts', () => {
      expect(check('a\tb')).toEqual({ ok: true, text: 'a\tb' });
      expect(check('Hello 👋 мир 世界')).toEqual({ ok: true, text: 'Hello 👋 мир 世界' });
    });

    it('trims invisible characters around the text, but not inside it', () => {
      expect(check('\u200B\u3164 hi \uFEFF')).toEqual({ ok: true, text: 'hi' });
      expect(check('a\u200Bb')).toEqual({ ok: true, text: 'a\u200Bb' });
    });

    it('does not count invisible characters inside the text', () => {
      expect(rejection('a\u200Bb'.repeat(MAX / 2))).toBe('ok');
      expect(rejection(`${'a'.repeat(MAX)}${'\u200B'.repeat(50)}`)).toBe('ok');
      expect(rejection('a\u200B\u200B\u200B')).toBe('tooShort');
    });

    it('keeps a zero-width joiner inside an emoji sequence', () => {
      const family = '👨\u200D👩\u200D👧';
      expect(check(`${family}${family}`)).toEqual({ ok: true, text: `${family}${family}` });
    });
  });

  describe('invalid maximum length', () => {
    it.each([0, 1, -5, 2.5, Number.NaN])('throws for %s', (maxLength) => {
      expect(() => validateMessageText('hello', maxLength)).toThrow(RangeError);
    });
  });
});
