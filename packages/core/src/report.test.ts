import { answers, assignments, blocks, questions, users, type NewUser } from '@human-msg/db';
import { createManualTime } from '@human-msg/db';
import { createTestDatabase, type TestDatabase } from '@human-msg/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCore } from './core';
import { findReceiver } from './matching';
import { askQuestion, reportAnswer, reportQuestion, submitAnswer } from './questions';
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
      alias: `Reporter ${counter}`,
      channel: 'telegram',
      telegramId: 3000 + counter,
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
const answer = (userId: string) => core().run((ctx) => submitAnswer(ctx, userId, 'An answer'));
const canReceive = async (authorId: string) =>
  core().run(async (ctx) => ok(await findReceiver(ctx, { id: crypto.randomUUID(), authorId })));
const receiverFor = async (authorId: string) => {
  const result = await canReceive(authorId);
  return result.ok ? result.value : undefined;
};
const allBlocks = () => testDb.db.select().from(blocks);

describe('reportQuestion', () => {
  it('ends the assignment as reported without a cooldown and passes the question on', async () => {
    const author = await createUser();
    const reporter = await createUser();
    const questionId = await ask(author.id);
    const other = await createUser();

    expect(await core().run((ctx) => reportQuestion(ctx, reporter.id))).toEqual({
      ok: true,
      value: { questionId },
    });

    const history = await testDb.db.select().from(assignments);
    expect(history.find((a) => a.receiverId === reporter.id)).toMatchObject({
      outcome: 'reported',
    });
    expect(history.find((a) => a.receiverId === other.id)).toMatchObject({ outcome: null });
    const [row] = await testDb.db.select().from(users).where(eq(users.id, reporter.id));
    expect(row!.cooldownUntil).toBeNull();
  });

  it('puts the question back into the queue when nobody else is available', async () => {
    const author = await createUser();
    const reporter = await createUser();
    await ask(author.id);
    await core().run((ctx) => reportQuestion(ctx, reporter.id));
    const [question] = await testDb.db.select().from(questions);
    expect(question!.status).toBe('queued');
  });

  it('blocks the author for the reporter only', async () => {
    const author = await createUser();
    const reporter = await createUser();
    const questionId = await ask(author.id);
    await core().run((ctx) => reportQuestion(ctx, reporter.id));

    expect(await allBlocks()).toMatchObject([
      { authorId: author.id, receiverId: reporter.id, reportedBy: reporter.id, questionId },
    ]);
    // The author's questions never go to the reporter, even after the cooldown rules are out
    expect(await receiverFor(author.id)).toBeUndefined();
    // But the reporter's own questions can still go to the author
    expect(await receiverFor(reporter.id)).toBe(author.id);
    // And other authors' questions still reach the reporter (the only other candidate here)
    await testDb.db.update(users).set({ receivingEnabled: false }).where(eq(users.id, author.id));
    const otherAuthor = await createUser({ receivingEnabled: false });
    expect(await receiverFor(otherAuthor.id)).toBe(reporter.id);
  });

  it('refuses when nothing is assigned to the user', async () => {
    const user = await createUser();
    expect(await core().run((ctx) => reportQuestion(ctx, user.id))).toEqual({
      ok: false,
      reason: 'no_active_assignment',
    });
    expect(await allBlocks()).toHaveLength(0);
  });
});

describe('reportAnswer', () => {
  async function answered() {
    const author = await createUser();
    const responder = await createUser();
    const questionId = await ask(author.id);
    await answer(responder.id);
    return { author, responder, questionId };
  }
  const report = (authorId: string, questionId: string) =>
    core().run((ctx) => reportAnswer(ctx, authorId, questionId));

  it('blocks the responder for the author', async () => {
    const { author, responder, questionId } = await answered();
    expect(await report(author.id, questionId)).toEqual({ ok: true, value: undefined });
    expect(await allBlocks()).toMatchObject([
      { authorId: author.id, receiverId: responder.id, reportedBy: author.id, questionId },
    ]);
  });

  it('is one-way: the responder still receives questions of others, the author gets theirs', async () => {
    const { author, responder, questionId } = await answered();
    await report(author.id, questionId);
    time.advance(2 * 3600 * 1000);
    // The responder's own questions can still go to the author
    expect(await receiverFor(responder.id)).toBe(author.id);
    // The author's questions never go to the responder
    expect(await receiverFor(author.id)).toBeUndefined();
    // Others are not affected
    const stranger = await createUser();
    expect([author.id, responder.id]).toContain(await receiverFor(stranger.id));
  });

  it('reporting the same responder twice is not an error', async () => {
    const { author, questionId } = await answered();
    await report(author.id, questionId);
    expect(await report(author.id, questionId)).toMatchObject({ ok: true });
    expect(await allBlocks()).toHaveLength(1);
  });

  it('refuses a question of someone else and an unknown question', async () => {
    const { responder, questionId } = await answered();
    expect(await report(responder.id, questionId)).toEqual({ ok: false, reason: 'not_found' });
    expect(await report((await createUser()).id, crypto.randomUUID())).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(await allBlocks()).toHaveLength(0);
  });

  it('refuses a question that has no answer yet', async () => {
    const author = await createUser();
    const questionId = await ask(author.id);
    expect(await report(author.id, questionId)).toEqual({ ok: false, reason: 'not_answered' });
    expect(await testDb.db.select().from(answers)).toHaveLength(0);
  });
});
