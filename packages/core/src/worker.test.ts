import { assignments, outbox, questions, users, webConnections, type NewUser } from '@human-msg/db';
import { createManualTime } from '@human-msg/db';
import { createTestDatabase, type TestDatabase } from '@human-msg/db/testing';
import { DEFAULT_SETTINGS } from '@human-msg/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCore } from './core';
import { askQuestion, skipAssignment, submitAnswer } from './questions';
import { processDeadlines } from './worker';

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
      alias: `Worker ${counter}`,
      channel: 'telegram',
      telegramId: 7000 + counter,
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
const MINUTE = 60 * 1000;
const historyOf = (questionId: string) =>
  testDb.db.select().from(assignments).where(eq(assignments.questionId, questionId));
const eventsOf = (userId: string) =>
  testDb.db.select().from(outbox).where(eq(outbox.userId, userId));

describe('processDeadlines', () => {
  it('times out an assignment 31 minutes later: cooldown, queue, event to the receiver', async () => {
    const author = await createUser();
    const receiver = await createUser();
    const questionId = await ask(author.id);

    time.advance(31 * MINUTE);
    expect(await processDeadlines(core())).toBe(1);

    const [assignment] = await historyOf(questionId);
    expect(assignment).toMatchObject({ outcome: 'timed_out' });
    expect(assignment!.endedAt).not.toBeNull();
    const [question] = await testDb.db.select().from(questions);
    expect(question!.status).toBe('queued');
    const [user] = await testDb.db.select().from(users).where(eq(users.id, receiver.id));
    expect(user!.cooldownUntil!.getTime() - assignment!.endedAt!.getTime()).toBe(
      DEFAULT_SETTINGS.COOLDOWN_SKIP * 1000,
    );
    expect((await eventsOf(receiver.id)).map((e) => e.type)).toEqual([
      'question.assigned',
      'assignment.expired',
    ]);
  });

  it('does nothing before the deadline and is idempotent afterwards', async () => {
    const author = await createUser();
    await createUser();
    const questionId = await ask(author.id);

    time.advance(29 * MINUTE);
    expect(await processDeadlines(core())).toBe(0);
    time.advance(2 * MINUTE);
    expect(await processDeadlines(core())).toBe(1);
    expect(await processDeadlines(core())).toBe(0);
    expect(await historyOf(questionId)).toHaveLength(1);
  });

  it('hands the question to another available receiver at once', async () => {
    const author = await createUser();
    const first = await createUser();
    const questionId = await ask(author.id);
    const second = await createUser();

    time.advance(31 * MINUTE);
    await processDeadlines(core());

    const history = await historyOf(questionId);
    expect(history.find((a) => a.receiverId === first.id)).toMatchObject({ outcome: 'timed_out' });
    expect(history.find((a) => a.receiverId === second.id)).toMatchObject({ outcome: null });
    const [question] = await testDb.db.select().from(questions);
    expect(question!.status).toBe('assigned');
  });

  it('uses the deadline stored at assignment time, not the current setting', async () => {
    const author = await createUser();
    await createUser();
    const questionId = await ask(author.id);
    const slow = createCore({
      db: testDb.db,
      time,
      settings: { get: async () => ({ ...DEFAULT_SETTINGS, ANSWER_TIMEOUT: 60 }) },
    });
    time.advance(5 * MINUTE);
    expect(await processDeadlines(slow)).toBe(0);
    expect((await historyOf(questionId))[0]!.outcome).toBeNull();
  });

  it('does not touch ended assignments', async () => {
    const author = await createUser();
    const receiver = await createUser({ channel: 'web', telegramId: null, googleSub: 'g-w' });
    await testDb.db.insert(webConnections).values({ userId: receiver.id, serverId: 's' });
    const questionId = await ask(author.id);
    await core().run((ctx) => skipAssignment(ctx, receiver.id));

    time.advance(31 * MINUTE);
    expect(await processDeadlines(core())).toBe(0);
    expect((await historyOf(questionId))[0]).toMatchObject({ outcome: 'skipped' });
  });

  it('an answer racing with the timeout is counted or refused, never both', async () => {
    for (let i = 0; i < 10; i++) {
      await testDb.reset();
      time.reset();
      const author = await createUser();
      const receiver = await createUser();
      const questionId = await ask(author.id);
      time.advance(31 * MINUTE);

      const [answer] = await Promise.all([
        core().run((ctx) => submitAnswer(ctx, receiver.id, 'Late or not')),
        processDeadlines(core()),
      ]);

      const [assignment] = (await historyOf(questionId)).filter(
        (a) => a.receiverId === receiver.id,
      );
      const [question] = await testDb.db.select().from(questions);
      if (answer.ok) {
        expect(assignment!.outcome).toBe('answered');
        expect(question!.status).toBe('answered');
      } else {
        expect(assignment!.outcome).toBe('timed_out');
        expect(question!.status).toBe('queued');
      }
    }
  });
});
