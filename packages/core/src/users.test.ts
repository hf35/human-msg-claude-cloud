import { users } from '@human-msg/db';
import { createTestDatabase, type TestDatabase } from '@human-msg/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCore } from './core';
import { ok } from './result';
import {
  createStaffUser,
  createTestUser,
  findUserByGoogleSub,
  findUserByTelegramId,
  getOrCreateUser,
} from './users';

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(() => testDb.close());
beforeEach(() => testDb.reset());

/** Always the same pick, so every alias collides with the previous one. */
const sameAlias = () => 0;

const core = () => createCore({ db: testDb.db });
const register = (googleSub: string, extra: { random?: () => number; locale?: 'ru' | 'en' } = {}) =>
  core().run(async ({ tx }) =>
    ok(
      await getOrCreateUser(
        tx,
        { channel: 'web', googleSub, locale: extra.locale },
        { random: extra.random },
      ),
    ),
  );

describe('getOrCreateUser', () => {
  it('registers a web user with an alias in their language', async () => {
    const ru = await register('g-ru', { locale: 'ru' });
    const en = await register('g-en', { locale: 'en' });
    if (!ru.ok || !en.ok) throw new Error('registration failed');
    expect(ru.value.created).toBe(true);
    expect(ru.value.user).toMatchObject({
      channel: 'web',
      locale: 'ru',
      googleSub: 'g-ru',
      telegramId: null,
    });
    expect(ru.value.user.alias).toMatch(/^[А-ЯЁа-яё ]+$/);
    expect(en.value.user.alias).toMatch(/^[A-Za-z ]+$/);
  });

  it('registers a Telegram user, including ids above 32 bits', async () => {
    const telegramId = 7_000_000_000;
    const result = await core().run(async ({ tx }) =>
      ok(await getOrCreateUser(tx, { channel: 'telegram', telegramId, locale: 'en' })),
    );
    if (!result.ok) throw new Error('registration failed');
    expect(result.value.user).toMatchObject({
      channel: 'telegram',
      telegramId,
      googleSub: null,
      locale: 'en',
    });
  });

  it('returns the same user and keeps the alias when the person comes again', async () => {
    const first = await register('g-1');
    const again = await register('g-1', { locale: 'en' });
    if (!first.ok || !again.ok) throw new Error('registration failed');
    expect(again.value.created).toBe(false);
    expect(again.value.user.id).toBe(first.value.user.id);
    expect(again.value.user.alias).toBe(first.value.user.alias);
    expect(again.value.user.locale).toBe('ru');
  });

  it('gives the numbered variant when the random combinations are taken', async () => {
    const aliases: string[] = [];
    for (const sub of ['a', 'b', 'c']) {
      const result = await register(sub, { random: sameAlias, locale: 'en' });
      if (!result.ok) throw new Error('registration failed');
      aliases.push(result.value.user.alias);
    }
    const [first] = aliases as [string];
    expect(aliases).toEqual([first, `${first} 2`, `${first} 3`]);
  });

  it('never gives two users the same alias under parallel registration', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => register(`parallel-${i}`, { random: sameAlias })),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    const aliases = (await testDb.db.select().from(users)).map((u) => u.alias);
    expect(aliases).toHaveLength(8);
    expect(new Set(aliases).size).toBe(8);
  });

  it('registers a person once when the same identity arrives in parallel', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => register('same-person')));
    const created = results.filter((r) => r.ok && r.value.created);
    expect(created).toHaveLength(1);
    const ids = new Set(results.map((r) => (r.ok ? r.value.user.id : '')));
    expect(ids.size).toBe(1);
    expect(await testDb.db.select().from(users)).toHaveLength(1);
  });

  it('does not leave the surrounding transaction broken after a rejected alias', async () => {
    await register('first', { random: sameAlias });
    const result = await core().run(async ({ tx }) => {
      const second = await getOrCreateUser(
        tx,
        { channel: 'web', googleSub: 'second' },
        { random: sameAlias },
      );
      // The same transaction keeps working afterwards
      const found = await findUserByGoogleSub(tx, 'second');
      return ok({ second, found });
    });
    if (!result.ok) throw new Error('registration failed');
    expect(result.value.found?.id).toBe(result.value.second.user.id);
  });
});

describe('finding users', () => {
  it('finds by Google sub and by Telegram id', async () => {
    await register('find-me');
    await core().run(async ({ tx }) =>
      ok(await getOrCreateUser(tx, { channel: 'telegram', telegramId: 42 })),
    );
    await core().run(async ({ tx }) => {
      expect((await findUserByGoogleSub(tx, 'find-me'))?.googleSub).toBe('find-me');
      expect((await findUserByTelegramId(tx, 42))?.telegramId).toBe(42);
      expect(await findUserByGoogleSub(tx, 'nobody')).toBeUndefined();
      expect(await findUserByTelegramId(tx, 43)).toBeUndefined();
      return ok();
    });
  });
});

describe('test and staff users', () => {
  it('creates a test user without identity in the test pool', async () => {
    const user = await testDb.db.transaction((tx) =>
      createTestUser(tx, { channel: 'telegram', locale: 'en' }),
    );
    expect(user).toMatchObject({
      isTest: true,
      isStaff: false,
      channel: 'telegram',
      googleSub: null,
      telegramId: null,
    });
  });

  it('creates a staff user with a unique alias', async () => {
    const [a, b] = await testDb.db.transaction(async (tx) => [
      await createStaffUser(tx, {}, { random: sameAlias }),
      await createStaffUser(tx, {}, { random: sameAlias }),
    ]);
    expect(a).toMatchObject({ isStaff: true, isTest: false, channel: 'web' });
    expect(b!.alias).toBe(`${a!.alias} 2`);
  });
});
