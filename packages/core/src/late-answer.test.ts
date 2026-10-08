import { answers, assignments, outbox, questions, users, type NewUser } from '@human-msg/db';
import { createManualTime } from '@human-msg/db';
import { createTestDatabase, type TestDatabase } from '@human-msg/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCore } from './core';
import { handleIncomingText } from './incoming';
import { askQuestion } from './questions';
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
      alias: `Late ${counter}`,
      channel: 'telegram',
      telegramId: 5000 + counter,
      ...values,
    })
    .returning();
  return user!;
}

const ask = async (authorId: string) => {
  const result = await core().run((ctx) => askQuestion(ctx, authorId, 'Original question'));
  if (!result.ok) throw new Error(result.reason);
  return result.value.questionId;
};
const send = (userId: string, text: string) =>
  core().run((ctx) => handleIncomingText(ctx, userId, text));
const MINUTE = 60 * 1000;

describe('late answer (rule 7)', () => {
  it('is not an answer after timed_out: no answer row, the question stays open', async () => {
    const author = await createUser();
    const receiver = await createUser();
    const questionId = await ask(author.id);
    time.advance(31 * MINUTE);
    await processDeadlines(core());

    const result = await send(receiver.id, 'Sorry, a bit late');

    expect(result).toMatchObject({ ok: true, value: { kind: 'asked' } });
    expect(await testDb.db.select().from(answers)).toHaveLength(0);
    const [question] = await testDb.db.select().from(questions).where(eq(questions.id, questionId));
    expect(question!.status).toBe('queued');
    const [assignment] = await testDb.db
      .select()
      .from(assignments)
      .where(eq(assignments.questionId, questionId));
    expect(assignment).toMatchObject({ outcome: 'timed_out' });
  });

  it('the receiver was told that the time is over', async () => {
    const author = await createUser();
    const receiver = await createUser();
    const questionId = await ask(author.id);
    time.advance(31 * MINUTE);
    await processDeadlines(core());

    const events = await testDb.db.select().from(outbox).where(eq(outbox.userId, receiver.id));
    const expired = events.filter((e) => e.type === 'assignment.expired');
    expect(expired).toHaveLength(1);
    expect(expired[0]!.payload).toMatchObject({ questionId });
  });

  it('is refused like any message when the user already waits for their own answer', async () => {
    const a = await createUser();
    const b = await createUser();
    const questionId = await ask(a.id);
    // b misses the deadline, then asks their own question
    time.advance(31 * MINUTE);
    await processDeadlines(core());
    const own = await send(b.id, 'My own question');
    expect(own).toMatchObject({ ok: true, value: { kind: 'asked' } });
    const late = await send(b.id, 'Late answer to the old one');
    expect(late).toEqual({ ok: false, reason: 'awaitingAnswer' });
    expect(await testDb.db.select().from(answers)).toHaveLength(0);
    const [question] = await testDb.db.select().from(questions).where(eq(questions.id, questionId));
    expect(question!.status).not.toBe('answered');
  });
});
