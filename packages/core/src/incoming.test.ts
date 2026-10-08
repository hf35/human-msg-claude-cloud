import { answers, assignments, outbox, questions, users, type NewUser } from '@human-msg/db';
import { createManualTime } from '@human-msg/db';
import { createTestDatabase, type TestDatabase } from '@human-msg/db/testing';
import { DEFAULT_SETTINGS } from '@human-msg/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCore, staticSettings } from './core';
import { handleIncomingText } from './incoming';

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
      alias: `Sender ${counter}`,
      channel: 'telegram',
      telegramId: 8000 + counter,
      ...values,
    })
    .returning();
  return user!;
}

const send = (userId: string, text: string | null, settings = DEFAULT_SETTINGS) =>
  core(settings).run((ctx) => handleIncomingText(ctx, userId, text));
const rejections = async (userId: string) =>
  (await testDb.db.select().from(outbox).where(eq(outbox.userId, userId)))
    .filter((event) => event.type === 'message.rejected')
    .map((event) => (event.payload as { reason: string }).reason);

describe('step 0: format', () => {
  it.each([
    ['empty', '   ​  '],
    ['tooShort', 'a'],
    ['tooLong', 'x'.repeat(DEFAULT_SETTINGS.MESSAGE_MAX_LENGTH + 1)],
  ])('refuses a %s text and stores nothing', async (reason, text) => {
    const user = await createUser();
    expect(await send(user.id, text)).toEqual({ ok: false, reason });
    expect(await rejections(user.id)).toEqual([reason]);
    expect(await testDb.db.select().from(questions)).toHaveLength(0);
  });

  it('refuses a message that is not text', async () => {
    const user = await createUser();
    expect(await send(user.id, null)).toEqual({ ok: false, reason: 'notText' });
    expect(await rejections(user.id)).toEqual(['notText']);
  });

  it('uses MESSAGE_MAX_LENGTH from the settings', async () => {
    const user = await createUser();
    const settings = { ...DEFAULT_SETTINGS, MESSAGE_MAX_LENGTH: 5 };
    expect(await send(user.id, 'abcdef', settings)).toEqual({ ok: false, reason: 'tooLong' });
    expect(await send(user.id, 'abcde', settings)).toMatchObject({ ok: true });
  });

  it('checks the format before the answer: a bad reply leaves the assignment active', async () => {
    const author = await createUser();
    const receiver = await createUser();
    await send(author.id, 'A question');
    expect(await send(receiver.id, 'x')).toEqual({ ok: false, reason: 'tooShort' });
    const [assignment] = await testDb.db.select().from(assignments);
    expect(assignment!.outcome).toBeNull();
  });

  it('cleans the text before storing it', async () => {
    const user = await createUser();
    await send(user.id, '  ​ Hello\u0000 there ​ ');
    const [question] = await testDb.db.select().from(questions);
    expect(question!.text).toBe('Hello there');
  });
});

describe('step 1: an answer', () => {
  it('treats the message of a user with an assigned question as the answer', async () => {
    const author = await createUser();
    const receiver = await createUser();
    await send(author.id, 'A question');
    const result = await send(receiver.id, 'The answer');
    expect(result).toMatchObject({ ok: true, value: { kind: 'answered' } });
    const [answer] = await testDb.db.select().from(answers);
    expect(answer).toMatchObject({ authorId: receiver.id, text: 'The answer' });
    expect(await testDb.db.select().from(questions)).toHaveLength(1);
  });

  it('rule 1: lets a user answer while they wait for an answer to their own question', async () => {
    const author = await createUser();
    const receiver = await createUser();
    await send(author.id, 'First question');
    // The receiver asked their own question earlier and is still waiting
    await testDb.db.insert(questions).values({
      authorId: receiver.id,
      text: 'My own question',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    expect(await send(receiver.id, 'My answer')).toMatchObject({
      ok: true,
      value: { kind: 'answered' },
    });
  });

  it('rule 1: lets a user answer when their daily limit is used up', async () => {
    const author = await createUser();
    const receiver = await createUser();
    await send(author.id, 'First question');
    for (let i = 0; i < DEFAULT_SETTINGS.QUESTIONS_PER_DAY; i++) {
      await testDb.db.insert(questions).values({
        authorId: receiver.id,
        text: `Old ${i}`,
        status: 'answered',
        answeredAt: new Date(),
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    }
    expect(await send(receiver.id, 'My answer')).toMatchObject({
      ok: true,
      value: { kind: 'answered' },
    });
  });
});

describe('steps 2-4: a question', () => {
  it('step 2: refuses while the user waits for an answer', async () => {
    const user = await createUser();
    await send(user.id, 'First question');
    expect(await send(user.id, 'Second question')).toEqual({
      ok: false,
      reason: 'awaitingAnswer',
    });
    expect(await rejections(user.id)).toEqual(['awaitingAnswer']);
  });

  it('step 3: refuses when the daily limit is used up', async () => {
    const user = await createUser();
    const settings = { ...DEFAULT_SETTINGS, QUESTIONS_PER_DAY: 1 };
    await send(user.id, 'First question', settings);
    await testDb.db
      .update(questions)
      .set({ status: 'answered', answeredAt: new Date() })
      .where(eq(questions.authorId, user.id));
    expect(await send(user.id, 'Second question', settings)).toEqual({
      ok: false,
      reason: 'dailyLimit',
    });
    expect(await rejections(user.id)).toEqual(['dailyLimit']);
  });

  it('step 4: assigns a new question when there is a receiver', async () => {
    const author = await createUser();
    await createUser();
    expect(await send(author.id, 'Anyone?')).toMatchObject({
      ok: true,
      value: { kind: 'asked', status: 'assigned' },
    });
  });

  it('step 4: queues a new question when there is no receiver', async () => {
    const author = await createUser();
    expect(await send(author.id, 'Anyone?')).toMatchObject({
      ok: true,
      value: { kind: 'asked', status: 'queued' },
    });
  });

  it('refuses an unknown user without an event', async () => {
    const unknown = '00000000-0000-4000-8000-000000000000';
    expect(await send(unknown, 'Hello')).toEqual({ ok: false, reason: 'user_not_found' });
  });
});
