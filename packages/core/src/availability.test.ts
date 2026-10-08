import { users, type NewUser } from '@human-msg/db';
import { createTestDatabase, type TestDatabase } from '@human-msg/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearServerConnections,
  connect,
  disconnect,
  isAvailable,
  setReceiving,
} from './availability';
import { createCore } from './core';
import { ok } from './result';

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(() => testDb.close());
beforeEach(() => testDb.reset());

const core = () => createCore({ db: testDb.db });
let counter = 0;

async function createUser(values: Partial<NewUser> & Pick<NewUser, 'channel'>) {
  counter++;
  const identity =
    values.channel === 'web' ? { googleSub: `g-${counter}` } : { telegramId: 1000 + counter };
  const [user] = await testDb.db
    .insert(users)
    .values({ alias: `Availability ${counter}`, ...identity, ...values })
    .returning();
  return user!;
}

const available = (userId: string) =>
  core().run(async ({ tx }) => ok(await isAvailable(tx, userId)));
const isAvailableNow = async (userId: string) => {
  const result = await available(userId);
  return result.ok && result.value;
};

describe('web availability', () => {
  it('needs an open connection', async () => {
    const user = await createUser({ channel: 'web' });
    expect(await isAvailableNow(user.id)).toBe(false);

    const connected = await core().run((ctx) => connect(ctx, user.id, 'server-1'));
    if (!connected.ok) throw new Error('connect failed');
    expect(await isAvailableNow(user.id)).toBe(true);

    await core().run((ctx) => disconnect(ctx, connected.value.connectionId));
    expect(await isAvailableNow(user.id)).toBe(false);
  });

  it('stays available until the last of several connections closes', async () => {
    const user = await createUser({ channel: 'web' });
    const first = await core().run((ctx) => connect(ctx, user.id, 'server-1'));
    const second = await core().run((ctx) => connect(ctx, user.id, 'server-1'));
    if (!first.ok || !second.ok) throw new Error('connect failed');

    await core().run((ctx) => disconnect(ctx, first.value.connectionId));
    expect(await isAvailableNow(user.id)).toBe(true);
    await core().run((ctx) => disconnect(ctx, second.value.connectionId));
    expect(await isAvailableNow(user.id)).toBe(false);
  });

  it('is not changed by the do-not-disturb flag', async () => {
    const user = await createUser({ channel: 'web' });
    await core().run((ctx) => connect(ctx, user.id, 'server-1'));
    await core().run((ctx) => setReceiving(ctx, user.id, false));
    expect(await isAvailableNow(user.id)).toBe(true);
  });

  it('forgets the connections of a restarted server only', async () => {
    const a = await createUser({ channel: 'web' });
    const b = await createUser({ channel: 'web' });
    await core().run((ctx) => connect(ctx, a.id, 'server-1'));
    await core().run((ctx) => connect(ctx, b.id, 'server-2'));
    await core().run((ctx) => clearServerConnections(ctx, 'server-1'));
    expect(await isAvailableNow(a.id)).toBe(false);
    expect(await isAvailableNow(b.id)).toBe(true);
  });

  it('tolerates closing a connection twice', async () => {
    const user = await createUser({ channel: 'web' });
    const connected = await core().run((ctx) => connect(ctx, user.id, 'server-1'));
    if (!connected.ok) throw new Error('connect failed');
    await core().run((ctx) => disconnect(ctx, connected.value.connectionId));
    expect(await core().run((ctx) => disconnect(ctx, connected.value.connectionId))).toEqual({
      ok: true,
      value: undefined,
    });
  });
});

describe('Telegram availability', () => {
  it('is available by default, without any connection', async () => {
    const user = await createUser({ channel: 'telegram' });
    expect(await isAvailableNow(user.id)).toBe(true);
  });

  it('follows the do-not-disturb mode', async () => {
    const user = await createUser({ channel: 'telegram' });
    await core().run((ctx) => setReceiving(ctx, user.id, false));
    expect(await isAvailableNow(user.id)).toBe(false);
    await core().run((ctx) => setReceiving(ctx, user.id, true));
    expect(await isAvailableNow(user.id)).toBe(true);
  });

  it('is unavailable after the bot was blocked', async () => {
    const user = await createUser({ channel: 'telegram', botBlockedAt: new Date() });
    expect(await isAvailableNow(user.id)).toBe(false);
    await testDb.db.update(users).set({ botBlockedAt: null }).where(eq(users.id, user.id));
    expect(await isAvailableNow(user.id)).toBe(true);
  });

  it('does not depend on recent activity', async () => {
    const user = await createUser({
      channel: 'telegram',
      lastSeenAt: new Date(Date.now() - 365 * 86_400_000),
    });
    expect(await isAvailableNow(user.id)).toBe(true);
  });
});

describe('commands refuse what does not make sense', () => {
  it('connect: unknown user and Telegram user', async () => {
    const telegram = await createUser({ channel: 'telegram' });
    expect(await core().run((ctx) => connect(ctx, telegram.id, 's'))).toEqual({
      ok: false,
      reason: 'not_a_web_user',
    });
    expect(
      await core().run((ctx) => connect(ctx, '00000000-0000-4000-8000-000000000000', 's')),
    ).toEqual({
      ok: false,
      reason: 'user_not_found',
    });
  });

  it('setReceiving: unknown user; isAvailable: unknown user', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    expect(await core().run((ctx) => setReceiving(ctx, missing, false))).toEqual({
      ok: false,
      reason: 'user_not_found',
    });
    expect(await isAvailableNow(missing)).toBe(false);
  });
});
