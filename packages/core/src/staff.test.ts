import { answers, outbox, questions, users, type NewUser } from '@human-msg/db';
import { createManualTime } from '@human-msg/db';
import { createTestDatabase, type TestDatabase } from '@human-msg/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCore } from './core';
import { findReceiver } from './matching';
import { askQuestion } from './questions';
import { ok } from './result';
import { staffAnswer } from './staff';

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
      alias: `Staffed ${counter}`,
      channel: 'telegram',
      telegramId: 1000 + counter,
      ...values,
    })
    .returning();
  return user!;
}

/** A question that nobody could answer in time. */
async function expiredQuestion(authorValues: Partial<NewUser> = {}) {
  const author = await createUser(authorValues);
  const asked = await core().run((ctx) => askQuestion(ctx, author.id, 'Is anyone there?'));
  if (!asked.ok) throw new Error(asked.reason);
  await testDb.db
    .update(questions)
    .set({ status: 'expired' })
    .where(eq(questions.id, asked.value.questionId));
  return { author, questionId: asked.value.questionId };
}
const answer = (questionId: string, text = 'Yes, we are here') =>
  core().run((ctx) => staffAnswer(ctx, questionId, text));

describe('staffAnswer', () => {
  it('stores an ordinary answer on behalf of a new staff user and answers the question', async () => {
    const { questionId } = await expiredQuestion();
    const result = await answer(questionId);
    if (!result.ok) throw new Error(result.reason);

    const [stored] = await testDb.db.select().from(answers);
    expect(stored).toMatchObject({
      questionId,
      authorId: result.value.responderId,
      text: 'Yes, we are here',
    });
    const [responder] = await testDb.db.select().from(users).where(eq(users.id, stored!.authorId));
    expect(responder).toMatchObject({ isStaff: true, isTest: false });
    const [question] = await testDb.db.select().from(questions);
    expect(question!.status).toBe('answered');
    expect(question!.answeredAt).not.toBeNull();
  });

  it('sends the author the answer like any other, without a team marker', async () => {
    const { author, questionId } = await expiredQuestion();
    const result = await answer(questionId);
    if (!result.ok) throw new Error(result.reason);
    const [responder] = await testDb.db
      .select()
      .from(users)
      .where(eq(users.id, result.value.responderId));
    const events = (
      await testDb.db.select().from(outbox).where(eq(outbox.userId, author.id))
    ).filter((event) => event.type === 'answer.received');
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toEqual({
      questionId,
      questionText: 'Is anyone there?',
      answerText: 'Yes, we are here',
      responderAlias: responder!.alias,
    });
  });

  it('gives each answer its own staff user with an alias in the language of the author', async () => {
    const ru = await expiredQuestion({ locale: 'ru' });
    const en = await expiredQuestion({ locale: 'en' });
    const first = await answer(ru.questionId);
    const second = await answer(en.questionId);
    if (!first.ok || !second.ok) throw new Error('answer failed');
    expect(first.value.responderId).not.toBe(second.value.responderId);
    const aliasOf = async (id: string) =>
      (await testDb.db.select().from(users).where(eq(users.id, id)))[0]!.alias;
    expect(await aliasOf(first.value.responderId)).toMatch(/[а-яё]/i);
    expect(await aliasOf(second.value.responderId)).not.toMatch(/[а-яё]/i);
  });

  it('never makes the staff user a receiver of questions', async () => {
    const { questionId } = await expiredQuestion();
    await answer(questionId);
    const stranger = await createUser();
    const picked = await core().run(async (ctx) =>
      ok(await findReceiver(ctx, { id: crypto.randomUUID(), authorId: stranger.id })),
    );
    // The only other non-staff user is the author of the answered question
    expect(picked.ok && picked.value).not.toBeUndefined();
    const staff = await testDb.db.select().from(users).where(eq(users.isStaff, true));
    expect(staff.map((user) => user.id)).not.toContain(picked.ok ? picked.value : null);
  });

  it.each(['queued', 'assigned', 'answered'] as const)('refuses a %s question', async (status) => {
    const { questionId } = await expiredQuestion();
    await testDb.db
      .update(questions)
      .set({ status, answeredAt: status === 'answered' ? new Date() : null })
      .where(eq(questions.id, questionId));
    expect(await answer(questionId)).toEqual({ ok: false, reason: 'not_expired' });
    expect(await testDb.db.select().from(answers)).toHaveLength(0);
    expect(await testDb.db.select().from(users).where(eq(users.isStaff, true))).toHaveLength(0);
  });

  it('refuses an unknown question and a bad text without leaving anything behind', async () => {
    const { questionId } = await expiredQuestion();
    expect(await answer(crypto.randomUUID())).toEqual({ ok: false, reason: 'not_found' });
    expect(await answer(questionId, '  ')).toEqual({ ok: false, reason: 'empty' });
    expect(await testDb.db.select().from(answers)).toHaveLength(0);
    expect(await testDb.db.select().from(users).where(eq(users.isStaff, true))).toHaveLength(0);
  });

  it('answers a question only once when two answers come at the same time', async () => {
    const { questionId } = await expiredQuestion();
    const results = await Promise.all([answer(questionId, 'first'), answer(questionId, 'second')]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(await testDb.db.select().from(answers)).toHaveLength(1);
  });
});
