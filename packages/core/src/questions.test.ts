import { assignments, outbox, questions, users, type NewUser } from '@human-msg/db';
import { createManualTime } from '@human-msg/db';
import { createTestDatabase, type TestDatabase } from '@human-msg/db/testing';
import { DEFAULT_SETTINGS } from '@human-msg/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCore, staticSettings } from './core';
import { askQuestion } from './questions';

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
