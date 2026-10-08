import {
  answers,
  assignments,
  outbox,
  questions,
  users,
  webConnections,
  type NewUser,
} from '@human-msg/db';
import { createManualTime } from '@human-msg/db';
import { createTestDatabase, type TestDatabase } from '@human-msg/db/testing';
import { DEFAULT_SETTINGS } from '@human-msg/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCore, staticSettings } from './core';
import { ok } from './result';
import { findReceiver } from './matching';
import { askQuestion, submitAnswer } from './questions';

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

const core = (settings = DEFAULT_SETTINGS) =>
  createCore({ db: testDb.db, time, settings: staticSettings(settings) });
let counter = 0;

async function createUser(values: Partial<NewUser> = {}) {
  counter++;
  const [user] = await testDb.db
    .insert(users)
    .values({
      alias: `Asker ${counter}`,
      channel: 'telegram',
      telegramId: 6000 + counter,
      ...values,
    })
    .returning();
  return user!;
}

const events = (userId: string) => testDb.db.select().from(outbox).where(eq(outbox.userId, userId));

describe('askQuestion', () => {
  it('assigns the question to an available receiver', async () => {
    const author = await createUser();
    const receiver = await createUser();

    const result = await core().run((ctx) => askQuestion(ctx, author.id, 'How are you?'));
    expect(result).toMatchObject({ ok: true, value: { status: 'assigned' } });
    if (!result.ok) return;

    const [question] = await testDb.db.select().from(questions);
    expect(question).toMatchObject({ id: result.value.questionId, status: 'assigned' });
    const [assignment] = await testDb.db.select().from(assignments);
    expect(assignment).toMatchObject({
      questionId: question!.id,
      receiverId: receiver.id,
      outcome: null,
    });
    // The receiver gets the full ANSWER_TIMEOUT
    expect(assignment!.deadlineAt.getTime() - assignment!.assignedAt.getTime()).toBe(
      DEFAULT_SETTINGS.ANSWER_TIMEOUT * 1000,
    );

    const [event] = await events(receiver.id);
    expect(event).toMatchObject({
      type: 'question.assigned',
      payload: {
        questionId: question!.id,
        text: 'How are you?',
        authorAlias: author.alias,
        deadlineAt: assignment!.deadlineAt.toISOString(),
      },
    });
    expect(await events(author.id)).toHaveLength(0);
  });

  it('queues the question when nobody can receive it', async () => {
    const author = await createUser();

    const result = await core().run((ctx) => askQuestion(ctx, author.id, 'Anyone there?'));
    expect(result).toMatchObject({ ok: true, value: { status: 'queued' } });

    const [question] = await testDb.db.select().from(questions);
    expect(question!.status).toBe('queued');
    expect(await testDb.db.select().from(assignments)).toHaveLength(0);
    const [event] = await events(author.id);
    expect(event).toMatchObject({
      type: 'question.queued',
      payload: { questionId: question!.id },
    });
  });

  it('fixes expires_at from QUESTION_TTL at creation', async () => {
    const author = await createUser();
    await core({ ...DEFAULT_SETTINGS, QUESTION_TTL: 7200 }).run((ctx) =>
      askQuestion(ctx, author.id, 'Hello?'),
    );
    const [question] = await testDb.db.select().from(questions);
    expect(question!.expiresAt.getTime() - question!.createdAt.getTime()).toBe(7200 * 1000);
  });

  it('refuses an unknown author and writes nothing', async () => {
    const result = await core().run((ctx) =>
      askQuestion(ctx, '00000000-0000-4000-8000-000000000000', 'Hi'),
    );
    expect(result).toEqual({ ok: false, reason: 'user_not_found' });
    expect(await testDb.db.select().from(questions)).toHaveLength(0);
  });
});

describe('rule 2: one pending question per author', () => {
  const ask = (authorId: string) =>
    core().run((ctx) => askQuestion(ctx, authorId, 'Another question'));

  it('refuses a second question while the first is queued', async () => {
    const author = await createUser();
    expect(await ask(author.id)).toMatchObject({ ok: true, value: { status: 'queued' } });
    expect(await ask(author.id)).toEqual({ ok: false, reason: 'awaiting_answer' });
    expect(await testDb.db.select().from(questions)).toHaveLength(1);
  });

  it('refuses a second question while the first is assigned', async () => {
    const author = await createUser();
    await createUser();
    expect(await ask(author.id)).toMatchObject({ ok: true, value: { status: 'assigned' } });
    expect(await ask(author.id)).toEqual({ ok: false, reason: 'awaiting_answer' });
    expect(await testDb.db.select().from(questions)).toHaveLength(1);
  });

  it('allows a new question after the previous one was answered', async () => {
    const author = await createUser();
    await ask(author.id);
    await testDb.db
      .update(questions)
      .set({ status: 'answered', answeredAt: new Date() })
      .where(eq(questions.authorId, author.id));
    expect(await ask(author.id)).toMatchObject({ ok: true });
  });

  it('allows a new question after the previous one expired', async () => {
    const author = await createUser();
    await ask(author.id);
    await testDb.db
      .update(questions)
      .set({ status: 'expired' })
      .where(eq(questions.authorId, author.id));
    expect(await ask(author.id)).toMatchObject({ ok: true });
  });

  it('does not let parallel sends of one author create two questions', async () => {
    const author = await createUser();
    const results = await Promise.all(Array.from({ length: 5 }, () => ask(author.id)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual(
      Array(4).fill({ ok: false, reason: 'awaiting_answer' }),
    );
    expect(await testDb.db.select().from(questions)).toHaveLength(1);
  });

  it("does not count other users' pending questions", async () => {
    const first = await createUser();
    const second = await createUser();
    await ask(first.id);
    expect(await ask(second.id)).toMatchObject({ ok: true });
  });
});

describe('rule 10: daily question limit', () => {
  const HOUR_MS = 3_600_000;
  const askWith = (authorId: string, limit = DEFAULT_SETTINGS.QUESTIONS_PER_DAY) =>
    core({ ...DEFAULT_SETTINGS, QUESTIONS_PER_DAY: limit }).run((ctx) =>
      askQuestion(ctx, authorId, 'Question'),
    );
  /** Ends the pending question so that the next one is not stopped by rule 2. */
  const finishPending = (authorId: string) =>
    testDb.db
      .update(questions)
      .set({ status: 'answered', answeredAt: new Date() })
      .where(eq(questions.authorId, authorId));

  it('lets 10 questions through by default and refuses the 11th', async () => {
    const author = await createUser();
    for (let i = 0; i < 10; i++) {
      expect(await askWith(author.id)).toMatchObject({ ok: true });
      await finishPending(author.id);
    }
    expect(await askWith(author.id)).toEqual({ ok: false, reason: 'daily_limit' });
    expect(await testDb.db.select().from(questions)).toHaveLength(10);
  });

  it('allows asking again once the oldest question leaves the 24-hour window', async () => {
    const author = await createUser();
    await askWith(author.id, 2);
    await finishPending(author.id);
    time.advance(12 * HOUR_MS);
    await askWith(author.id, 2);
    await finishPending(author.id);
    expect(await askWith(author.id, 2)).toEqual({ ok: false, reason: 'daily_limit' });

    // 24 hours after the first question: it drops out of the window, the second still counts
    time.advance(12 * HOUR_MS + 1000);
    expect(await askWith(author.id, 2)).toMatchObject({ ok: true });
    await finishPending(author.id);
    expect(await askWith(author.id, 2)).toEqual({ ok: false, reason: 'daily_limit' });
  });

  it('counts only own questions, and expired ones too', async () => {
    const author = await createUser();
    const other = await createUser();
    await askWith(author.id, 1);
    await testDb.db
      .update(questions)
      .set({ status: 'expired' })
      .where(eq(questions.authorId, author.id));
    expect(await askWith(author.id, 1)).toEqual({ ok: false, reason: 'daily_limit' });
    expect(await askWith(other.id, 1)).toMatchObject({ ok: true });
  });

  it('reports a pending question before the limit', async () => {
    const author = await createUser();
    await askWith(author.id, 1);
    expect(await askWith(author.id, 1)).toEqual({ ok: false, reason: 'awaiting_answer' });
  });

  it('uses the current QUESTIONS_PER_DAY setting', async () => {
    const author = await createUser();
    await askWith(author.id, 1);
    await finishPending(author.id);
    expect(await askWith(author.id, 1)).toEqual({ ok: false, reason: 'daily_limit' });
    expect(await askWith(author.id, 2)).toMatchObject({ ok: true });
  });
});

describe('submitAnswer', () => {
  const answer = (userId: string, text = 'My answer') =>
    core().run((ctx) => submitAnswer(ctx, userId, text));
  /** An author whose question is assigned to the only possible receiver. */
  async function assigned(receiverValues: Partial<NewUser> = {}) {
    const author = await createUser();
    const receiver = await createUser(receiverValues);
    const asked = await core().run((ctx) => askQuestion(ctx, author.id, 'Why?'));
    if (!asked.ok || asked.value.status !== 'assigned') throw new Error('not assigned');
    return { author, receiver, questionId: asked.value.questionId };
  }
  const nextReceiver = (authorId: string) =>
    core().run(async (ctx) => ok(await findReceiver(ctx, { id: crypto.randomUUID(), authorId })));
  const cooldownMs = async (userId: string) => {
    const [user] = await testDb.db.select().from(users).where(eq(users.id, userId));
    const [assignment] = await testDb.db
      .select()
      .from(assignments)
      .where(eq(assignments.receiverId, userId));
    return user!.cooldownUntil!.getTime() - assignment!.endedAt!.getTime();
  };

  it('stores the answer as its own row and finishes the question and the assignment', async () => {
    const { receiver, questionId } = await assigned();
    expect(await answer(receiver.id)).toEqual({ ok: true, value: { questionId } });

    const [stored] = await testDb.db.select().from(answers);
    expect(stored).toMatchObject({ questionId, authorId: receiver.id, text: 'My answer' });
    const [question] = await testDb.db.select().from(questions);
    expect(question!.status).toBe('answered');
    expect(question!.answeredAt).not.toBeNull();
    const [assignment] = await testDb.db.select().from(assignments);
    expect(assignment!.outcome).toBe('answered');
    expect(assignment!.endedAt).not.toBeNull();
  });

  it('sends the author the answer together with the question', async () => {
    const { author, receiver, questionId } = await assigned();
    await answer(receiver.id, 'Because');
    const sent = (await events(author.id)).filter((event) => event.type === 'answer.received');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload).toEqual({
      questionId,
      questionText: 'Why?',
      answerText: 'Because',
      responderAlias: receiver.alias,
    });
  });

  it('starts a 1-hour cooldown for a Telegram receiver', async () => {
    const { receiver } = await assigned({ channel: 'telegram' });
    await answer(receiver.id);
    expect(await cooldownMs(receiver.id)).toBe(DEFAULT_SETTINGS.COOLDOWN_TELEGRAM * 1000);
    expect(DEFAULT_SETTINGS.COOLDOWN_TELEGRAM).toBe(3600);
  });

  it('starts a 5-minute cooldown for a web receiver', async () => {
    const author = await createUser();
    const receiver = await createUser({ channel: 'web', telegramId: null, googleSub: 'g-web' });
    await testDb.db.insert(webConnections).values({ userId: receiver.id, serverId: 's1' });
    await core().run((ctx) => askQuestion(ctx, author.id, 'Why?'));
    await answer(receiver.id);
    expect(await cooldownMs(receiver.id)).toBe(DEFAULT_SETTINGS.COOLDOWN_WEB * 1000);
    expect(DEFAULT_SETTINGS.COOLDOWN_WEB).toBe(300);
  });

  it('keeps the receiver out of selection during the cooldown only', async () => {
    const { author, receiver } = await assigned({ channel: 'telegram' });
    await answer(receiver.id);
    // The author is the only other user, so the receiver is the sole candidate for their question
    expect(await nextReceiver(author.id)).toMatchObject({ value: undefined });
    time.advance(3600 * 1000 + 1000);
    expect(await nextReceiver(author.id)).toMatchObject({ value: receiver.id });
  });

  it('refuses when nothing is assigned to the user', async () => {
    const user = await createUser();
    expect(await answer(user.id)).toEqual({ ok: false, reason: 'no_active_assignment' });
    expect(await testDb.db.select().from(answers)).toHaveLength(0);
  });

  it('refuses a second answer to the same question', async () => {
    const { receiver } = await assigned();
    await answer(receiver.id);
    expect(await answer(receiver.id)).toEqual({ ok: false, reason: 'no_active_assignment' });
    expect(await testDb.db.select().from(answers)).toHaveLength(1);
  });

  it('refuses when the assignment has ended', async () => {
    const { receiver } = await assigned();
    await testDb.db
      .update(assignments)
      .set({ outcome: 'timed_out', endedAt: new Date() })
      .where(eq(assignments.receiverId, receiver.id));
    expect(await answer(receiver.id)).toEqual({ ok: false, reason: 'no_active_assignment' });
  });

  it('accepts the answer of a user who is waiting for an answer to their own question', async () => {
    const { receiver } = await assigned();
    // The receiver asks their own question and waits for it (rule 1 must not block the answer)
    const own = await core().run((ctx) => askQuestion(ctx, receiver.id, 'And me?'));
    expect(own).toMatchObject({ ok: true });
    expect(await answer(receiver.id)).toMatchObject({ ok: true });
  });

  it('counts two parallel answers once', async () => {
    const { receiver } = await assigned();
    const results = await Promise.all([answer(receiver.id, 'a'), answer(receiver.id, 'b')]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await testDb.db.select().from(answers)).toHaveLength(1);
  });
});
