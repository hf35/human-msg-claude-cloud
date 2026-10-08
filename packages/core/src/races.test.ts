import { answers, assignments, questions, users, type NewUser } from '@human-msg/db';
import { createManualTime } from '@human-msg/db';
import { createTestDatabase, type TestDatabase } from '@human-msg/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connect } from './availability';
import { createCore } from './core';
import { handleIncomingText } from './incoming';
import { askQuestion, reportQuestion, skipAssignment, submitAnswer } from './questions';
import { markUndeliverable } from './undeliverable';

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
      alias: `Racer ${counter}`,
      channel: 'telegram',
      telegramId: 500 + counter,
      ...values,
    })
    .returning();
  return user!;
}

const ROUNDS = 15;

describe('rule 3: parallel questions never give a receiver two', () => {
  it('many authors, one free receiver: exactly one assignment', async () => {
    for (let round = 0; round < 5; round++) {
      await testDb.reset();
      const receiver = await createUser();
      const authors = await Promise.all(Array.from({ length: 12 }, () => createUser()));
      // Only the receiver is a candidate for everybody but themselves
      await testDb.db
        .update(users)
        .set({ receivingEnabled: false })
        .where(eq(users.channel, 'telegram'));
      await testDb.db
        .update(users)
        .set({ receivingEnabled: true })
        .where(eq(users.id, receiver.id));

      const results = await Promise.all(
        authors.map((author) => core().run((ctx) => askQuestion(ctx, author.id, 'Parallel?'))),
      );

      expect(results.every((result) => result.ok)).toBe(true);
      const active = (await testDb.db.select().from(assignments)).filter((a) => a.outcome === null);
      expect(active).toHaveLength(1);
      expect(active[0]!.receiverId).toBe(receiver.id);
      const statuses = (await testDb.db.select().from(questions)).map((q) => q.status);
      expect(statuses.filter((status) => status === 'assigned')).toHaveLength(1);
      expect(statuses.filter((status) => status === 'queued')).toHaveLength(11);
    }
  });

  it('many authors, several receivers: nobody gets two, nothing is lost', async () => {
    for (let round = 0; round < 5; round++) {
      await testDb.reset();
      const receivers = await Promise.all(Array.from({ length: 4 }, () => createUser()));
      const authors = await Promise.all(Array.from({ length: 10 }, () => createUser()));
      await testDb.db.update(users).set({ receivingEnabled: false });
      for (const receiver of receivers) {
        await testDb.db
          .update(users)
          .set({ receivingEnabled: true })
          .where(eq(users.id, receiver.id));
      }

      await Promise.all(
        authors.map((author) => core().run((ctx) => askQuestion(ctx, author.id, 'Parallel?'))),
      );

      const active = (await testDb.db.select().from(assignments)).filter((a) => a.outcome === null);
      expect(new Set(active.map((a) => a.receiverId)).size).toBe(active.length);
      const all = await testDb.db.select().from(questions);
      expect(all).toHaveLength(10);
      expect(all.filter((q) => q.status === 'assigned')).toHaveLength(active.length);
      expect(active.length).toBeGreaterThan(0);
      expect(active.length).toBeLessThanOrEqual(4);
    }
  });

  it('a user connecting while questions are asked still gets at most one', async () => {
    for (let round = 0; round < 5; round++) {
      await testDb.reset();
      const web = await createUser({ channel: 'web', telegramId: null, googleSub: `g-${round}` });
      const authors = await Promise.all(Array.from({ length: 6 }, () => createUser()));
      await testDb.db
        .update(users)
        .set({ receivingEnabled: false })
        .where(eq(users.channel, 'telegram'));

      await Promise.all([
        core().run((ctx) => connect(ctx, web.id, 's1')),
        ...authors.map((author) => core().run((ctx) => askQuestion(ctx, author.id, 'Parallel?'))),
      ]);

      const active = (await testDb.db.select().from(assignments)).filter((a) => a.outcome === null);
      expect(active.length).toBeLessThanOrEqual(1);
      expect(await testDb.db.select().from(questions)).toHaveLength(6);
    }
  });
});

describe('an answer racing with another way to end the assignment', () => {
  /** An author and a receiver with the question assigned to the receiver. */
  async function assignedPair() {
    await testDb.reset();
    const author = await createUser();
    const receiver = await createUser();
    await testDb.db.update(users).set({ receivingEnabled: false }).where(eq(users.id, author.id));
    const asked = await core().run((ctx) => askQuestion(ctx, author.id, 'Race?'));
    if (!asked.ok || asked.value.status !== 'assigned') throw new Error('not assigned');
    return { author, receiver, questionId: asked.value.questionId };
  }

  /** Exactly one of the two commands won, and the stored state agrees with the winner. */
  async function expectOneOutcome(
    receiverId: string,
    answerOk: boolean,
    otherOk: boolean,
    otherOutcome: 'skipped' | 'reported' | 'undeliverable',
  ) {
    expect([answerOk, otherOk].filter(Boolean)).toHaveLength(1);
    const history = await testDb.db
      .select()
      .from(assignments)
      .where(eq(assignments.receiverId, receiverId));
    expect(history).toHaveLength(1);
    const [question] = await testDb.db.select().from(questions);
    const stored = await testDb.db.select().from(answers);
    if (answerOk) {
      expect(history[0]!.outcome).toBe('answered');
      expect(question!.status).toBe('answered');
      expect(stored).toHaveLength(1);
    } else {
      expect(history[0]!.outcome).toBe(otherOutcome);
      expect(question!.status).toBe('queued');
      expect(stored).toHaveLength(0);
    }
  }

  it('answer and skip: exactly one is counted', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { receiver } = await assignedPair();
      const [answer, skip] = await Promise.all([
        core().run((ctx) => submitAnswer(ctx, receiver.id, 'Answer')),
        core().run((ctx) => skipAssignment(ctx, receiver.id)),
      ]);
      await expectOneOutcome(receiver.id, answer.ok, skip.ok, 'skipped');
    }
  });

  it('answer and report: exactly one is counted', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { receiver } = await assignedPair();
      const [answer, report] = await Promise.all([
        core().run((ctx) => submitAnswer(ctx, receiver.id, 'Answer')),
        core().run((ctx) => reportQuestion(ctx, receiver.id)),
      ]);
      await expectOneOutcome(receiver.id, answer.ok, report.ok, 'reported');
    }
  });

  it('answer and the bot being blocked: exactly one is counted', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { receiver } = await assignedPair();
      const [answer, blocked] = await Promise.all([
        core().run((ctx) => submitAnswer(ctx, receiver.id, 'Answer')),
        core().run((ctx) => markUndeliverable(ctx, receiver.id)),
      ]);
      // Blocking the bot always succeeds; it only takes the question back if the answer lost
      expect(blocked.ok).toBe(true);
      const [assignment] = await testDb.db.select().from(assignments);
      const answered = answer.ok;
      expect(assignment!.outcome).toBe(answered ? 'answered' : 'undeliverable');
      expect((await testDb.db.select().from(answers)).length).toBe(answered ? 1 : 0);
    }
  });

  it('two answers at once: one is counted', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { receiver } = await assignedPair();
      const results = await Promise.all([
        core().run((ctx) => handleIncomingText(ctx, receiver.id, 'First answer')),
        core().run((ctx) => handleIncomingText(ctx, receiver.id, 'Second answer')),
      ]);
      expect(await testDb.db.select().from(answers)).toHaveLength(1);
      // The second message, arriving after the assignment ended, is the receiver's own question
      expect(results.every((result) => result.ok || result.reason === 'awaitingAnswer')).toBe(true);
    }
  });
});
