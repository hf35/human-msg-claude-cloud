import { assignments, blocks, questions, users, webConnections, type NewUser } from '@human-msg/db';
import { createManualTime } from '@human-msg/db';
import { createTestDatabase, type TestDatabase } from '@human-msg/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCore } from './core';
import { findReceiver } from './matching';
import { ok } from './result';

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
      alias: `Matching ${counter}`,
      channel: 'telegram',
      telegramId: 5000 + counter,
      ...values,
    })
    .returning();
  return user!;
}

/** The author of a question; web users are unavailable without a connection, so never picked. */
async function createQuestion(authorValues: Partial<NewUser> = {}) {
  const author = await createUser({
    channel: 'web',
    telegramId: null,
    googleSub: `g-${counter + 1}`,
    ...authorValues,
  });
  const [question] = await testDb.db
    .insert(questions)
    .values({ authorId: author.id, text: 'Question?', expiresAt: new Date(Date.now() + 3_600_000) })
    .returning();
  return { author, question: question! };
}

const find = (question: { id: string; authorId: string }) =>
  core().run(async (ctx) => ok(await findReceiver(ctx, question)));
const found = async (question: { id: string; authorId: string }) => {
  const result = await find(question);
  return result.ok ? result.value : undefined;
};

const startAssignment = (questionId: string, receiverId: string, outcome?: 'skipped') =>
  testDb.db.insert(assignments).values({
    questionId,
    receiverId,
    deadlineAt: new Date(Date.now() + 1_800_000),
    ...(outcome ? { outcome, endedAt: new Date() } : {}),
  });

describe('findReceiver', () => {
  it('finds an available user', async () => {
    const { question } = await createQuestion();
    const receiver = await createUser();
    expect(await found(question)).toBe(receiver.id);
  });

  it('finds nobody when there are no candidates', async () => {
    const { question } = await createQuestion();
    expect(await found(question)).toBeUndefined();
  });

  it('skips unavailable users: web without connection, Telegram with do-not-disturb or blocked bot', async () => {
    const { question } = await createQuestion();
    await createUser({ channel: 'web', telegramId: null, googleSub: 'g-offline' });
    await createUser({ receivingEnabled: false });
    await createUser({ botBlockedAt: new Date() });
    expect(await found(question)).toBeUndefined();
  });

  it('accepts a web user with an open connection', async () => {
    const { question } = await createQuestion();
    const web = await createUser({ channel: 'web', telegramId: null, googleSub: 'g-online' });
    await testDb.db.insert(webConnections).values({ userId: web.id, serverId: 's1' });
    expect(await found(question)).toBe(web.id);
  });

  it('keeps live and test users in separate pools', async () => {
    const live = await createQuestion();
    const test = await createQuestion({ isTest: true });
    const liveReceiver = await createUser();
    const testReceiver = await createUser({ isTest: true });
    expect(await found(live.question)).toBe(liveReceiver.id);
    expect(await found(test.question)).toBe(testReceiver.id);
  });

  it('never picks staff users', async () => {
    const live = await createQuestion();
    const test = await createQuestion({ isTest: true });
    await createUser({ isStaff: true });
    await createUser({ isStaff: true, isTest: true });
    expect(await found(live.question)).toBeUndefined();
    expect(await found(test.question)).toBeUndefined();
  });

  it('skips a busy user', async () => {
    const { question } = await createQuestion();
    const other = await createQuestion();
    const busy = await createUser();
    await startAssignment(other.question.id, busy.id);
    expect(await found(question)).toBeUndefined();
  });

  it('skips a user on cooldown until it ends', async () => {
    const { question } = await createQuestion();
    await createUser({ cooldownUntil: new Date(Date.now() + 600_000) });
    expect(await found(question)).toBeUndefined();
    time.advance(601_000);
    expect(await found(question)).toBeDefined();
  });

  it('never picks the author', async () => {
    const { question } = await createQuestion({
      channel: 'telegram',
      telegramId: 9999,
      googleSub: null,
    });
    expect(await found(question)).toBeUndefined();
  });

  it('skips a user who already had this question, but not for another question', async () => {
    const { question } = await createQuestion();
    const other = await createQuestion();
    const receiver = await createUser();
    await startAssignment(question.id, receiver.id, 'skipped');
    expect(await found(question)).toBeUndefined();
    expect(await found(other.question)).toBe(receiver.id);
  });

  it('skips a receiver blocked for this author only', async () => {
    const { author, question } = await createQuestion();
    const other = await createQuestion();
    const receiver = await createUser();
    await testDb.db.insert(blocks).values({
      authorId: author.id,
      receiverId: receiver.id,
      reportedBy: receiver.id,
      questionId: question.id,
    });
    expect(await found(question)).toBeUndefined();
    expect(await found(other.question)).toBe(receiver.id);
  });

  it('does not block the opposite direction', async () => {
    const { author, question } = await createQuestion({
      channel: 'telegram',
      telegramId: 7777,
      googleSub: null,
    });
    const receiver = await createUser();
    // The receiver's questions are excluded for the author, not the other way round
    await testDb.db.insert(blocks).values({
      authorId: receiver.id,
      receiverId: author.id,
      reportedBy: author.id,
      questionId: question.id,
    });
    expect(await found(question)).toBe(receiver.id);
  });

  it('picks among all suitable users, not always the same one', async () => {
    const { question } = await createQuestion();
    const ids = new Set([
      (await createUser()).id,
      (await createUser()).id,
      (await createUser()).id,
    ]);
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) seen.add((await found(question))!);
    expect(seen.size).toBeGreaterThan(1);
    for (const id of seen) expect(ids.has(id)).toBe(true);
  });

  it('skips a candidate locked by a parallel transaction', async () => {
    const { question } = await createQuestion();
    const first = await createUser();
    const second = await createUser();
    let secondPick: string | undefined;
    const firstPick = await core().run(async (ctx) => {
      const pick = await findReceiver(ctx, question);
      // While the first transaction holds its candidate, another one must get the other user
      const inner = await createCore({ db: testDb.db, time }).run(async (innerCtx) =>
        ok(await findReceiver(innerCtx, question)),
      );
      secondPick = inner.ok ? inner.value : undefined;
      return ok(pick);
    });
    expect(firstPick.ok && firstPick.value).toBeDefined();
    expect(secondPick).toBeDefined();
    expect(new Set([firstPick.ok && firstPick.value, secondPick])).toEqual(
      new Set([first.id, second.id]),
    );
  });
});
