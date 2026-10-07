import { describe, expect, it } from 'vitest';
import { randomAlias, type RandomSource } from './index';
import { enAdjectives, enAnimals, ruAdjectives, ruAnimals } from './words';

// Small deterministic generator, so that failures are reproducible
function seeded(seed: number): RandomSource {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CYRILLIC = /[А-Яа-яЁё]/;

function draw(locale: string, count: number): string[] {
  const random = seeded(42);
  return Array.from({ length: count }, () => randomAlias(locale, random));
}

describe('word lists', () => {
  const lists = { ruAdjectives, ruAnimals, enAdjectives, enAnimals };

  it('are large enough, have no duplicates and no empty words', () => {
    for (const [name, words] of Object.entries(lists)) {
      expect(words.length, name).toBeGreaterThanOrEqual(90);
      expect(new Set(words).size, `${name}: duplicates`).toBe(words.length);
      for (const word of words) expect(word.trim(), name).not.toBe('');
    }
  });

  it('keep the languages apart', () => {
    for (const word of [...ruAdjectives, ...ruAnimals]) expect(word).toMatch(/^[А-Яа-яЁё]+$/);
    for (const word of [...enAdjectives, ...enAnimals]) expect(word).toMatch(/^[A-Za-z]+$/);
  });

  it('are capitalised single words', () => {
    for (const word of Object.values(lists).flat()) {
      expect(word).toMatch(/^\p{Lu}\p{Ll}+$/u);
    }
  });
});

describe('randomAlias', () => {
  it('builds "Adjective Animal" from the lists of the language', () => {
    for (const alias of draw('ru', 500)) {
      const [adjective, animal] = alias.split(' ') as [string, string];
      expect(ruAdjectives, alias).toContain(adjective);
      expect(ruAnimals, alias).toContain(animal);
    }
    for (const alias of draw('en', 500)) {
      const [adjective, animal] = alias.split(' ') as [string, string];
      expect(enAdjectives, alias).toContain(adjective);
      expect(enAnimals, alias).toContain(animal);
    }
  });

  it('uses only English words for English and only Cyrillic for Russian', () => {
    for (const alias of draw('en', 500)) expect(alias).not.toMatch(CYRILLIC);
    for (const alias of draw('ru', 500)) expect(alias).toMatch(/^[А-Яа-яЁё ]+$/);
  });

  it('gives plenty of variety', () => {
    // 90+ x 90+ combinations: 2000 draws should give well over a thousand different aliases
    for (const locale of ['ru', 'en']) {
      expect(new Set(draw(locale, 2000)).size, locale).toBeGreaterThan(1200);
    }
  });

  it('reaches the whole word lists', () => {
    for (const [locale, adjectives, animals] of [
      ['ru', ruAdjectives, ruAnimals],
      ['en', enAdjectives, enAnimals],
    ] as const) {
      const seen = new Set(draw(locale, 20000).flatMap((alias) => alias.split(' ')));
      for (const word of [...adjectives, ...animals]) expect(seen.has(word), word).toBe(true);
    }
  });

  it('is deterministic for a given random source', () => {
    expect(draw('ru', 50)).toEqual(draw('ru', 50));
    expect(draw('en', 50)).toEqual(draw('en', 50));
  });

  it('handles the edges of the random range', () => {
    for (const locale of ['ru', 'en']) {
      expect(() => randomAlias(locale, () => 0)).not.toThrow();
      expect(() => randomAlias(locale, () => 0.9999999999999999)).not.toThrow();
      // A misbehaving source that returns exactly 1 must not index out of range
      expect(() => randomAlias(locale, () => 1)).not.toThrow();
    }
    expect(randomAlias('ru', () => 0)).toBe('Зелёный Кролик');
    expect(randomAlias('en', () => 0)).toBe('Green Rabbit');
  });

  it('falls back to Russian for an unknown or missing locale', () => {
    expect(randomAlias(undefined, () => 0)).toBe('Зелёный Кролик');
    expect(randomAlias(null, () => 0)).toBe('Зелёный Кролик');
    expect(randomAlias('de', () => 0)).toBe('Зелёный Кролик');
  });

  it('works without an explicit random source', () => {
    expect(randomAlias('en')).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
  });
});
