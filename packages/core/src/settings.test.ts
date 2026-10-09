import { createTestDatabase, type TestDatabase } from '@human-msg/db/testing';
import { DEFAULT_SETTINGS } from '@human-msg/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSettingsStore } from './settings';

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(() => testDb.close());
beforeEach(() => testDb.reset());

describe('settings store', () => {
  it('returns the defaults when nothing is stored', async () => {
    const store = createSettingsStore({ db: testDb.db });
    expect(await store.get()).toEqual(DEFAULT_SETTINGS);
  });

  it('saves a change and returns it', async () => {
    const store = createSettingsStore({ db: testDb.db });
    const result = await store.set({ ANSWER_TIMEOUT: 600 });
    expect(result).toMatchObject({ ok: true, value: { ANSWER_TIMEOUT: 600 } });
    expect((await store.get()).ANSWER_TIMEOUT).toBe(600);
    // Other keys keep their defaults, and the value survives a new store (a restart)
    const other = createSettingsStore({ db: testDb.db });
    expect(await other.get()).toEqual({ ...DEFAULT_SETTINGS, ANSWER_TIMEOUT: 600 });
  });

  it('serves a cached value until the cache expires or is dropped', async () => {
    let now = 0;
    const reader = createSettingsStore({ db: testDb.db, cacheMs: 5_000, clock: () => now });
    const writer = createSettingsStore({ db: testDb.db });
    expect((await reader.get()).QUESTIONS_PER_DAY).toBe(10);

    await writer.set({ QUESTIONS_PER_DAY: 3 });
    // Another instance wrote: this one still shows the old value ...
    expect((await reader.get()).QUESTIONS_PER_DAY).toBe(10);
    // ... until the cache expires
    now = 5_000;
    expect((await reader.get()).QUESTIONS_PER_DAY).toBe(3);

    await writer.set({ QUESTIONS_PER_DAY: 4 });
    reader.invalidate();
    expect((await reader.get()).QUESTIONS_PER_DAY).toBe(4);
  });

  it('shows its own writes immediately', async () => {
    const store = createSettingsStore({ db: testDb.db, cacheMs: 60_000 });
    await store.get();
    await store.set({ COOLDOWN_WEB: 0 });
    expect((await store.get()).COOLDOWN_WEB).toBe(0);
  });

  it('resets keys back to their defaults', async () => {
    const store = createSettingsStore({ db: testDb.db });
    await store.set({ QUESTION_TTL: 7200, QUESTIONS_PER_DAY: 2 });
    await store.reset('QUESTION_TTL');
    expect(await store.get()).toEqual({ ...DEFAULT_SETTINGS, QUESTIONS_PER_DAY: 2 });
  });

  it('refuses invalid and unknown values and stores nothing', async () => {
    const store = createSettingsStore({ db: testDb.db });
    expect(await store.set({ QUESTIONS_PER_DAY: 0 })).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
    expect(await store.set({ NOPE: 1 })).toMatchObject({ ok: false, reason: 'unknown_key' });
    // Valid on its own, invalid together with the stored timeout (reminder < timeout)
    expect(await store.set({ ANSWER_REMINDER: 3600 })).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
    // One bad value rejects the whole change
    expect(await store.set({ COOLDOWN_WEB: 1, QUESTIONS_PER_DAY: 0 })).toMatchObject({ ok: false });
    expect(await store.get()).toEqual(DEFAULT_SETTINGS);
  });

  it('shares one query between concurrent readers', async () => {
    const store = createSettingsStore({ db: testDb.db });
    const results = await Promise.all([store.get(), store.get(), store.get()]);
    expect(results[0]).toBe(results[1]);
    expect(results[1]).toBe(results[2]);
  });

  describe('a read that overlaps a save', () => {
    // A database whose reads finish only when the test allows: the rows are read at once, so the
    // read holds the values from before a save that commits while it waits
    function withHeldReads() {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const db = new Proxy(testDb.db, {
        get(target, prop) {
          if (prop === 'select') {
            return (...args: unknown[]) => {
              const query = (
                target.select as (...a: unknown[]) => ReturnType<typeof target.select>
              )(...args);
              return {
                from: async (table: Parameters<typeof query.from>[0]) => {
                  const rows = await query.from(table);
                  await gate;
                  return rows;
                },
              };
            };
          }
          const value = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      return { db: db as typeof testDb.db, release };
    }

    it('does not keep the old values in the cache after the save commits', async () => {
      const { db, release } = withHeldReads();
      const store = createSettingsStore({ db, cacheMs: 60_000 });

      const early = store.get(); // reads the old rows, then waits
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect((await store.set({ MESSAGE_MAX_LENGTH: 100 })).ok).toBe(true);
      release();

      // The early read may return what it saw, but it must not poison the cache
      expect((await early).MESSAGE_MAX_LENGTH).toBe(DEFAULT_SETTINGS.MESSAGE_MAX_LENGTH);
      expect((await store.get()).MESSAGE_MAX_LENGTH).toBe(100);
    });

    it('does not let a reader that arrives after the save share the old read', async () => {
      const { db, release } = withHeldReads();
      const store = createSettingsStore({ db, cacheMs: 60_000 });

      const early = store.get();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await store.set({ MESSAGE_MAX_LENGTH: 100 });
      const late = store.get(); // must start its own read
      release();

      expect((await late).MESSAGE_MAX_LENGTH).toBe(100);
      await early;
    });

    it('a refused save leaves the cache alone', async () => {
      const store = createSettingsStore({ db: testDb.db, cacheMs: 60_000 });
      await store.get();
      await store.set({ ANSWER_TIMEOUT: 600 });
      expect((await store.set({ ANSWER_TIMEOUT: -1 })).ok).toBe(false);
      expect((await store.get()).ANSWER_TIMEOUT).toBe(600);
    });
  });
});
