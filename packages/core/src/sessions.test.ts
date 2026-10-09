import { createManualTime, sessions, users } from '@human-msg/db';
import { createTestDatabase, type TestDatabase } from '@human-msg/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCore, type Core } from './core';
import { createSession, deleteSession, purgeExpiredSessions, resolveSession } from './sessions';

let testDb: TestDatabase;
let core: Core;
const time = createManualTime();

beforeAll(async () => {
  testDb = await createTestDatabase();
  core = createCore({ db: testDb.db, time });
});
afterAll(() => testDb.close());
beforeEach(async () => {
  time.reset();
  await testDb.reset();
});

async function createUser() {
  const [user] = await testDb.db
    .insert(users)
    .values({ alias: 'Green Rabbit', channel: 'web', googleSub: 'sub-1' })
    .returning();
  return user!;
}

describe('sessions', () => {
  it('a created session resolves to its user until it expires', async () => {
    const user = await createUser();
    const created = await core.run((ctx) => createSession(ctx, user.id, 60));
    if (!created.ok) throw new Error('unreachable');

    const found = await core.run((ctx) => resolveSession(ctx, created.value.token));
    expect(found).toMatchObject({ ok: true, value: { id: user.id } });

    time.advance(61_000);
    expect(await core.run((ctx) => resolveSession(ctx, created.value.token))).toEqual({
      ok: false,
      reason: 'no_session',
    });
  });

  it('refuses an unknown token', async () => {
    expect(await core.run((ctx) => resolveSession(ctx, 'nope'))).toEqual({
      ok: false,
      reason: 'no_session',
    });
  });

  it('deleteSession ends the session', async () => {
    const user = await createUser();
    const created = await core.run((ctx) => createSession(ctx, user.id));
    if (!created.ok) throw new Error('unreachable');
    await core.run((ctx) => deleteSession(ctx, created.value.token));
    expect((await core.run((ctx) => resolveSession(ctx, created.value.token))).ok).toBe(false);
  });

  it('purgeExpiredSessions removes only the expired ones', async () => {
    const user = await createUser();
    await core.run((ctx) => createSession(ctx, user.id, 10));
    await core.run((ctx) => createSession(ctx, user.id, 1000));
    time.advance(60_000);
    expect(await purgeExpiredSessions(core)).toBe(1);
    expect(await testDb.db.select().from(sessions)).toHaveLength(1);
  });
});
