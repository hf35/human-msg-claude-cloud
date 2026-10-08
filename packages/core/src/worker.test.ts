import { assignments, outbox, questions, users, webConnections, type NewUser } from '@human-msg/db';
import { createManualTime } from '@human-msg/db';
import { createTestDatabase, type TestDatabase } from '@human-msg/db/testing';
import { DEFAULT_SETTINGS } from '@human-msg/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCore } from './core';
import { assignFromQueue } from './queue';
import { ok } from './result';
import { askQuestion, skipAssignment, submitAnswer } from './questions';
import {
  processDeadlines,
  processExpiredQuestions,
  processQueue,
  processReminders,
} from './worker';

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

describe('processReminders', () => {
  const remindersOf = async (userId: string) =>
    (await eventsOf(userId)).filter((e) => e.type === 'assignment.reminder');

  it('sends one reminder at minute 25 and none on a repeated pass', async () => {
    const author = await createUser();
    const receiver = await createUser();
    const questionId = await ask(author.id);

    time.advance(24 * MINUTE);
    expect(await processReminders(core())).toBe(0);

    time.advance(1 * MINUTE);
    expect(await processReminders(core())).toBe(1);
    expect(await processReminders(core())).toBe(0);
    time.advance(2 * MINUTE);
    expect(await processReminders(core())).toBe(0);

    const events = await remindersOf(receiver.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ questionId, secondsLeft: 300 });
    const [assignment] = await historyOf(questionId);
    expect(assignment!.remindedAt).not.toBeNull();
  });

  it('does not remind about an ended assignment or one past its deadline', async () => {
    const author = await createUser();
    const receiver = await createUser();
    await ask(author.id);
    await core().run((ctx) => submitAnswer(ctx, receiver.id, 'Answer'));
    time.advance(26 * MINUTE);
    expect(await processReminders(core())).toBe(0);

    await testDb.reset();
    time.reset();
    const author2 = await createUser();
    const receiver2 = await createUser();
    await ask(author2.id);
    time.advance(31 * MINUTE);
    expect(await processReminders(core())).toBe(0);
    expect(await remindersOf(receiver2.id)).toHaveLength(0);
  });

  it('reminds again for a new assignment of the same question', async () => {
    const author = await createUser();
    const first = await createUser();
    const questionId = await ask(author.id);
    time.advance(26 * MINUTE);
    await processReminders(core());
    const second = await createUser();
    time.advance(5 * MINUTE);
    await processDeadlines(core());
    expect((await historyOf(questionId)).find((a) => a.receiverId === second.id)).toBeDefined();

    time.advance(26 * MINUTE);
    expect(await processReminders(core())).toBe(1);
    expect(await remindersOf(first.id)).toHaveLength(1);
    expect(await remindersOf(second.id)).toHaveLength(1);
  });
});

describe('processExpiredQuestions', () => {
  const HOUR = 60 * MINUTE;

  it('expires a queued question after QUESTION_TTL and tells the author', async () => {
    const author = await createUser();
    const questionId = await ask(author.id); // nobody to receive it: queued

    time.advance(2 * HOUR);
    expect(await processExpiredQuestions(core())).toBe(0);
    time.advance(HOUR + MINUTE);
    expect(await processExpiredQuestions(core())).toBe(1);
    expect(await processExpiredQuestions(core())).toBe(0);

    const [question] = await testDb.db.select().from(questions);
    expect(question).toMatchObject({ id: questionId, status: 'expired' });
    const events = (await eventsOf(author.id)).filter((e) => e.type === 'question.expired');
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ questionId });
  });

  /** The question waits in the queue, then is handed over 15 minutes before its lifetime ends. */
  async function lateAssignment() {
    const author = await createUser();
    const questionId = await ask(author.id);
    time.advance(3 * HOUR - 15 * MINUTE);
    const receiver = await createUser();
    await core().run(async (ctx) => ok(await assignFromQueue(ctx, receiver.id)));
    expect((await testDb.db.select().from(questions))[0]!.status).toBe('assigned');
    return { questionId, receiver };
  }

  it('does not expire an assigned question; the receiver may still answer after TTL', async () => {
    const { questionId, receiver } = await lateAssignment();
    time.advance(20 * MINUTE); // TTL is over, the receiver has 25 more minutes
    expect(await processExpiredQuestions(core())).toBe(0);
    const answered = await core().run((ctx) => submitAnswer(ctx, receiver.id, 'Just in time'));
    expect(answered).toMatchObject({ ok: true, value: { questionId } });
    expect((await testDb.db.select().from(questions))[0]!.status).toBe('answered');
  });

  it('expires the question once the full term of its receiver ends unanswered', async () => {
    const { questionId } = await lateAssignment();
    time.advance(46 * MINUTE);
    await processDeadlines(core());
    // Back in the queue, but its lifetime is over: nobody gets it any more
    expect((await testDb.db.select().from(questions))[0]!.status).toBe('queued');
    expect(await processExpiredQuestions(core())).toBe(1);
    expect((await testDb.db.select().from(questions))[0]).toMatchObject({
      id: questionId,
      status: 'expired',
    });
  });
});

describe('processQueue', () => {
  const HOUR = 60 * MINUTE;

  it('assigns a queued question when the only receiver cooldown is over', async () => {
    const asker1 = await createUser({ receivingEnabled: false });
    const receiver = await createUser();
    const first = await ask(asker1.id);
    await core().run((ctx) => submitAnswer(ctx, receiver.id, 'Done')); // cooldown 1 hour
    const asker2 = await createUser({ receivingEnabled: false });
    const second = await ask(asker2.id);
    expect(
      (await testDb.db.select().from(questions).where(eq(questions.id, second)))[0]!.status,
    ).toBe('queued');
    expect(first).not.toBe(second);

    time.advance(30 * MINUTE);
    expect(await processQueue(core())).toBe(0);

    time.advance(31 * MINUTE);
    expect(await processQueue(core())).toBe(1);
    expect(await processQueue(core())).toBe(0);
    const [assignment] = await historyOf(second);
    expect(assignment).toMatchObject({ receiverId: receiver.id, outcome: null });
    expect((await eventsOf(receiver.id)).map((e) => e.type)).toContain('question.assigned');
  });

  it('serves the oldest question first when there is one free receiver', async () => {
    const a1 = await createUser({ receivingEnabled: false });
    const a2 = await createUser({ receivingEnabled: false });
    const older = await ask(a1.id);
    time.advance(MINUTE);
    const newer = await ask(a2.id);
    const receiver = await createUser();

    expect(await processQueue(core())).toBe(1);

    expect(await historyOf(older)).toMatchObject([{ receiverId: receiver.id }]);
    expect(await historyOf(newer)).toHaveLength(0);
  });

  it('leaves expired and unmatched questions alone', async () => {
    const author = await createUser({ receivingEnabled: false });
    const questionId = await ask(author.id);
    expect(await processQueue(core())).toBe(0);

    await createUser();
    time.advance(3 * HOUR + MINUTE);
    expect(await processQueue(core())).toBe(0);
    expect(await historyOf(questionId)).toHaveLength(0);
  });
});
