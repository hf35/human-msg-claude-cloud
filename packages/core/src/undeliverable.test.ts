import { assignments, questions, users, type NewUser } from '@human-msg/db';
import { createManualTime } from '@human-msg/db';
import { createTestDatabase, type TestDatabase } from '@human-msg/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isAvailable } from './availability';
import { createCore } from './core';
import { askQuestion } from './questions';
import { ok } from './result';
import { markReachable, markUndeliverable } from './undeliverable';

let testDb: TestDatabase;
const time = createManualTime();

beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(() => testDb.close());
beforeEach(async () => {
  time.reset();
  await testDb.reset();
});

const core = () => createCore({ db: testDb.db, time });
let counter = 0;

async function createUser(values: Partial<NewUser> = {}) {
  counter++;
  const [user] = await testDb.db
    .insert(users)
    .values({
      alias: `Blocker ${counter}`,
      channel: 'telegram',
      telegramId: 2000 + counter,
      ...values,
    })
    .returning();
  return user!;
}

const ask = async (authorId: string) => {
  const result = await core().run((ctx) => askQuestion(ctx, authorId, 'A question'));
  if (!result.ok) throw new Error(result.reason);
  return result.value.questionId;
};
const undeliverable = (userId: string) => core().run((ctx) => markUndeliverable(ctx, userId));
const reachable = (userId: string) => core().run((ctx) => markReachable(ctx, userId));
const available = async (userId: string) => {
  const result = await core().run(async ({ tx }) => ok(await isAvailable(tx, userId)));
  return result.ok && result.value;
};
const userRow = async (id: string) =>
  (await testDb.db.select().from(users).where(eq(users.id, id)))[0]!;

describe('markUndeliverable', () => {
  it('makes the user unavailable', async () => {
    const user = await createUser();
    expect(await undeliverable(user.id)).toEqual({ ok: true, value: undefined });
    expect((await userRow(user.id)).botBlockedAt).not.toBeNull();
    expect(await available(user.id)).toBe(false);
  });

  it('takes back the assigned question at once, without a cooldown, and passes it on', async () => {
    const author = await createUser();
    const blocker = await createUser();
    const questionId = await ask(author.id);
    const other = await createUser();

    await undeliverable(blocker.id);

    const history = await testDb.db.select().from(assignments);
    expect(history.find((a) => a.receiverId === blocker.id)).toMatchObject({
      questionId,
      outcome: 'undeliverable',
    });
    expect(history.find((a) => a.receiverId === other.id)).toMatchObject({ outcome: null });
    expect((await userRow(blocker.id)).cooldownUntil).toBeNull();
  });

  it('puts the question back into the queue when nobody else is available', async () => {
    const author = await createUser();
    const blocker = await createUser();
    await ask(author.id);
    await undeliverable(blocker.id);
    const [question] = await testDb.db.select().from(questions);
    expect(question!.status).toBe('queued');
  });

  it('does not change anything else when the user had no question', async () => {
    const user = await createUser();
    await undeliverable(user.id);
    expect(await testDb.db.select().from(assignments)).toHaveLength(0);
  });

  it('keeps the first time of blocking when reported again', async () => {
    const user = await createUser();
    await undeliverable(user.id);
    const first = (await userRow(user.id)).botBlockedAt;
    time.advance(60_000);
    await undeliverable(user.id);
    expect((await userRow(user.id)).botBlockedAt).toEqual(first);
  });

  it('refuses unknown and web users', async () => {
    const web = await createUser({ channel: 'web', telegramId: null, googleSub: 'g-1' });
    expect(await undeliverable(web.id)).toEqual({ ok: false, reason: 'not_a_telegram_user' });
    expect(await undeliverable(crypto.randomUUID())).toEqual({
      ok: false,
      reason: 'user_not_found',
    });
  });
});

describe('markReachable', () => {
  it('makes the user available again', async () => {
    const user = await createUser({ botBlockedAt: new Date() });
    expect(await available(user.id)).toBe(false);
    expect(await reachable(user.id)).toEqual({ ok: true, value: undefined });
    expect((await userRow(user.id)).botBlockedAt).toBeNull();
    expect(await available(user.id)).toBe(true);
  });

  it('gives the returning user a queued question', async () => {
    const author = await createUser();
    const questionId = await ask(author.id);
    const user = await createUser({ botBlockedAt: new Date() });
    await reachable(user.id);
    const [assignment] = await testDb.db.select().from(assignments);
    expect(assignment).toMatchObject({ questionId, receiverId: user.id, outcome: null });
  });

  it('does not override the do-not-disturb mode', async () => {
    const user = await createUser({ botBlockedAt: new Date(), receivingEnabled: false });
    await reachable(user.id);
    expect(await available(user.id)).toBe(false);
  });

  it('is harmless for a user who was never blocked', async () => {
    const user = await createUser();
    expect(await reachable(user.id)).toEqual({ ok: true, value: undefined });
  });

  it('refuses unknown and web users', async () => {
    const web = await createUser({ channel: 'web', telegramId: null, googleSub: 'g-2' });
    expect(await reachable(web.id)).toEqual({ ok: false, reason: 'not_a_telegram_user' });
    expect(await reachable(crypto.randomUUID())).toEqual({ ok: false, reason: 'user_not_found' });
  });
});
