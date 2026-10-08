import { assignments, outbox, questions, users, webConnections, type NewUser } from '@human-msg/db';
import { createManualTime } from '@human-msg/db';
import { createTestDatabase, type TestDatabase } from '@human-msg/db/testing';
import { DEFAULT_SETTINGS } from '@human-msg/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCore } from './core';
import { findReceiver } from './matching';
import { ok } from './result';
import { askQuestion, skipAssignment } from './questions';

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
      alias: `Skipper ${counter}`,
      channel: 'telegram',
      telegramId: 9000 + counter,
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
const skip = (userId: string) => core().run((ctx) => skipAssignment(ctx, userId));
const historyOf = (questionId: string) =>
  testDb.db.select().from(assignments).where(eq(assignments.questionId, questionId));

describe('skipAssignment', () => {
  it('ends the assignment as skipped and hands the question to someone else at once', async () => {
    const author = await createUser();
    const first = await createUser();
    const questionId = await ask(author.id);
    const second = await createUser();

    expect(await skip(first.id)).toEqual({ ok: true, value: { questionId } });

    const history = await historyOf(questionId);
    expect(history).toHaveLength(2);
    expect(history.find((a) => a.receiverId === first.id)).toMatchObject({ outcome: 'skipped' });
    expect(history.find((a) => a.receiverId === second.id)).toMatchObject({ outcome: null });
    const [question] = await testDb.db.select().from(questions);
    expect(question!.status).toBe('assigned');
    const events = await testDb.db.select().from(outbox).where(eq(outbox.userId, second.id));
    expect(events.map((e) => e.type)).toEqual(['question.assigned']);
  });

  it('puts the question back into the queue when nobody else is available', async () => {
    const author = await createUser();
    const receiver = await createUser();
    const questionId = await ask(author.id);
    await skip(receiver.id);
    const [question] = await testDb.db.select().from(questions);
    expect(question!.status).toBe('queued');
    expect((await historyOf(questionId)).filter((a) => a.outcome === null)).toHaveLength(0);
  });

  it('starts COOLDOWN_SKIP for the receiver in both channels', async () => {
    for (const channel of ['telegram', 'web'] as const) {
      await testDb.reset();
      const author = await createUser();
      const receiver =
        channel === 'telegram'
          ? await createUser()
          : await createUser({ channel: 'web', telegramId: null, googleSub: `g-${counter}` });
      if (channel === 'web') {
        await testDb.db.insert(webConnections).values({ userId: receiver.id, serverId: 's' });
      }
      const questionId = await ask(author.id);
      await skip(receiver.id);
      const [user] = await testDb.db.select().from(users).where(eq(users.id, receiver.id));
      const [assignment] = await historyOf(questionId);
      expect(user!.cooldownUntil!.getTime() - assignment!.endedAt!.getTime()).toBe(
        DEFAULT_SETTINGS.COOLDOWN_SKIP * 1000,
      );
    }
  });

  it('never gives the question back to the user who skipped it', async () => {
    const author = await createUser();
    const receiver = await createUser();
    const questionId = await ask(author.id);
    await skip(receiver.id);
    time.advance(2 * 3600 * 1000);
    // The cooldown is over and the receiver is the only candidate, but already had this question
    const picked = await core().run(async (ctx) =>
      ok(await findReceiver(ctx, { id: questionId, authorId: author.id })),
    );
    expect(picked).toEqual({ ok: true, value: undefined });
  });

  it('does not hand out a question whose lifetime is over', async () => {
    const author = await createUser();
    const receiver = await createUser();
    const questionId = await ask(author.id);
    await createUser();
    time.advance((DEFAULT_SETTINGS.QUESTION_TTL + 1) * 1000);
    await skip(receiver.id);
    const [question] = await testDb.db.select().from(questions);
    expect(question!.status).toBe('queued');
    expect((await historyOf(questionId)).filter((a) => a.outcome === null)).toHaveLength(0);
  });

  it('refuses when nothing is assigned to the user', async () => {
    const user = await createUser();
    expect(await skip(user.id)).toEqual({ ok: false, reason: 'no_active_assignment' });
  });
});
