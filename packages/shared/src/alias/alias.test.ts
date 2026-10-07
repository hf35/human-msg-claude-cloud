import { describe, expect, it } from 'vitest';
import { randomAlias, type RandomSource } from './index';
import {
  enAdjectives,
  enAnimals,
  ruAdjectives,
  ruFeminineAnimals,
  ruMasculineAnimals,
} from './words';

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
const DRAWS = 5000;

function draw(locale: string, count = DRAWS): string[] {
  const random = seeded(42);
  return Array.from({ length: count }, () => randomAlias(locale, random));
}

describe('word lists', () => {
  it('have no duplicates and no empty words', () => {
    const lists = {
      ruAdjectiveMasculine: ruAdjectives.map((a) => a.masculine),
      ruAdjectiveFeminine: ruAdjectives.map((a) => a.feminine),
      ruMasculineAnimals: [...ruMasculineAnimals],
      ruFeminineAnimals: [...ruFeminineAnimals],
      enAdjectives: [...enAdjectives],
      enAnimals: [...enAnimals],
    };
    for (const [name, words] of Object.entries(lists)) {
      expect(words.length, name).toBeGreaterThan(10);
      expect(new Set(words).size, `${name}: duplicates`).toBe(words.length);
      for (const word of words) expect(word.trim(), name).not.toBe('');
    }
  });

  it('give every Russian adjective two different forms', () => {
    for (const adjective of ruAdjectives) {
      expect(adjective.feminine).not.toBe(adjective.masculine);
    }
  });
});

describe('randomAlias', () => {
  it('builds "Adjective Animal" from two capitalised words', () => {
    for (const locale of ['ru', 'en']) {
      for (const alias of draw(locale, 200)) {
        expect(alias).toMatch(/^\p{Lu}\p{Ll}+ \p{Lu}\p{Ll}+$/u);
      }
    }
  });

  it('agrees the Russian adjective with the gender of the animal', () => {
    const masculine = new Set(ruAdjectives.map((a) => a.masculine));
    const feminine = new Set(ruAdjectives.map((a) => a.feminine));
    const seen = { masculine: 0, feminine: 0 };

    for (const alias of draw('ru')) {
      const [adjective, animal] = alias.split(' ') as [string, string];
      if (ruMasculineAnimals.includes(animal)) {
        expect(masculine.has(adjective), alias).toBe(true);
        seen.masculine++;
      } else {
        expect(ruFeminineAnimals.includes(animal), alias).toBe(true);
        expect(feminine.has(adjective), alias).toBe(true);
        seen.feminine++;
      }
    }
    // Both genders really occur
    expect(seen.masculine).toBeGreaterThan(0);
    expect(seen.feminine).toBeGreaterThan(0);
  });

  it('uses only English words for English and only Cyrillic for Russian', () => {
    for (const alias of draw('en', 500)) {
      expect(alias).not.toMatch(CYRILLIC);
      const [adjective, animal] = alias.split(' ') as [string, string];
      expect(enAdjectives).toContain(adjective);
      expect(enAnimals).toContain(animal);
    }
    for (const alias of draw('ru', 500)) expect(alias).toMatch(/^[А-Яа-яЁё ]+$/);
  });

  it('gives plenty of variety', () => {
    for (const locale of ['ru', 'en']) {
      expect(new Set(draw(locale, 1000)).size, locale).toBeGreaterThan(300);
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
