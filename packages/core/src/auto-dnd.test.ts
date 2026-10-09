import { outbox, questions, users, type NewUser } from '@human-msg/db';
import { createManualTime } from '@human-msg/db';
import { createTestDatabase, type TestDatabase } from '@human-msg/db/testing';
import { DEFAULT_SETTINGS } from '@human-msg/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setReceiving } from './availability';
import { createCore } from './core';
import { askQuestion, skipAssignment, submitAnswer } from './questions';
import { processDeadlines } from './worker';
import { webConnections } from '@human-msg/db';

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

const core = (autoDnd?: number) =>
  createCore({
    db: testDb.db,
    time,
    settings: {
      get: async () => ({ ...DEFAULT_SETTINGS, AUTO_DND_AFTER_MISSED: autoDnd ?? 3 }),
    },
  });
let counter = 0;

async function createUser(values: Partial<NewUser> = {}) {
  counter++;
  const [user] = await testDb.db
    .insert(users)
    .values({
      alias: `Dnd ${counter}`,
      channel: 'telegram',
      telegramId: 2000 + counter,
      ...values,
    })
    .returning();
  return user!;
}

const MINUTE = 60 * 1000;
const userRow = async (id: string) =>
  (await testDb.db.select().from(users).where(eq(users.id, id)))[0]!;

/** A new question reaches the receiver, who stays silent until the deadline passes. */
async function miss(receiverId: string, autoDnd?: number) {
  const author = await createUser({ receivingEnabled: false });
  const asked = await core(autoDnd).run((ctx) => askQuestion(ctx, author.id, 'Anyone there?'));
  expect(asked).toMatchObject({ ok: true, value: { status: 'assigned' } });
  time.advance(31 * MINUTE);
  await processDeadlines(core(autoDnd));
  time.advance(61 * MINUTE); // the cooldown is over
}
const autoDisabledEvents = async (userId: string) =>
  (await testDb.db.select().from(outbox).where(eq(outbox.userId, userId))).filter(
    (e) => e.type === 'receiving.auto_disabled',
  );

describe('automatic "do not disturb"', () => {
  it('switches on after three missed deadlines in a row and tells the user once', async () => {
    const receiver = await createUser();
    await miss(receiver.id);
    await miss(receiver.id);
    expect(await userRow(receiver.id)).toMatchObject({
      receivingEnabled: true,
      missedDeadlines: 2,
    });
    expect(await autoDisabledEvents(receiver.id)).toHaveLength(0);

    await miss(receiver.id);
    expect(await userRow(receiver.id)).toMatchObject({
      receivingEnabled: false,
      missedDeadlines: 0,
    });
    const events = await autoDisabledEvents(receiver.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ missedDeadlines: 3 });
  });

  it('takes the user out of the pool: the next question is not assigned to them', async () => {
    const receiver = await createUser();
    for (let i = 0; i < 3; i++) await miss(receiver.id);

    const author = await createUser({ receivingEnabled: false });
    const asked = await core().run((ctx) => askQuestion(ctx, author.id, 'Is anyone awake?'));
    expect(asked).toMatchObject({ ok: true, value: { status: 'queued' } });
  });

  it('the question that was missed the third time goes on to someone else at once', async () => {
    const sleeper = await createUser();
    await miss(sleeper.id);
    await miss(sleeper.id);
    const author = await createUser({ receivingEnabled: false });
    await core().run((ctx) => askQuestion(ctx, author.id, 'Third time lucky'));
    const active = await createUser(); // would be picked if the sleeper were out
    time.advance(31 * MINUTE);
    await processDeadlines(core());
    const [question] = await testDb.db
      .select()
      .from(questions)
      .where(eq(questions.authorId, author.id));
    expect(question!.status).toBe('assigned');
    expect((await userRow(sleeper.id)).receivingEnabled).toBe(false);
    expect(active.id).toBeDefined();
  });

  it('an answer resets the count', async () => {
    const receiver = await createUser();
    await miss(receiver.id);
    await miss(receiver.id);
    const author = await createUser({ receivingEnabled: false });
    await core().run((ctx) => askQuestion(ctx, author.id, 'Answer me'));
    await core().run((ctx) => submitAnswer(ctx, receiver.id, 'Here I am'));
    expect((await userRow(receiver.id)).missedDeadlines).toBe(0);
    time.advance(2 * 60 * MINUTE);
    await miss(receiver.id);
    await miss(receiver.id);
    expect((await userRow(receiver.id)).receivingEnabled).toBe(true);
  });

  it('a skip resets the count', async () => {
    const receiver = await createUser();
    await miss(receiver.id);
    await miss(receiver.id);
    const author = await createUser({ receivingEnabled: false });
    await core().run((ctx) => askQuestion(ctx, author.id, 'Skip me'));
    await core().run((ctx) => skipAssignment(ctx, receiver.id));
    expect((await userRow(receiver.id)).missedDeadlines).toBe(0);
  });

  it('after /resume the user gets a fresh start', async () => {
    const receiver = await createUser();
    for (let i = 0; i < 3; i++) await miss(receiver.id);
    await core().run((ctx) => setReceiving(ctx, receiver.id, true));
    await miss(receiver.id);
    await miss(receiver.id);
    expect((await userRow(receiver.id)).receivingEnabled).toBe(true);
    await miss(receiver.id);
    expect((await userRow(receiver.id)).receivingEnabled).toBe(false);
  });

  it('never touches web users: the open page decides their availability', async () => {
    const receiver = await createUser({ channel: 'web', telegramId: null, googleSub: 'g-dnd' });
    await testDb.db.insert(webConnections).values({ userId: receiver.id, serverId: 's' });
    for (let i = 0; i < 4; i++) await miss(receiver.id);
    expect(await userRow(receiver.id)).toMatchObject({
      receivingEnabled: true,
      missedDeadlines: 0,
    });
    expect(await autoDisabledEvents(receiver.id)).toHaveLength(0);
  });

  it('follows the setting: another limit, or 0 to switch the feature off', async () => {
    const receiver = await createUser();
    await miss(receiver.id, 2);
    await miss(receiver.id, 2);
    expect((await userRow(receiver.id)).receivingEnabled).toBe(false);

    await testDb.reset();
    const other = await createUser();
    for (let i = 0; i < 5; i++) await miss(other.id, 0);
    expect((await userRow(other.id)).receivingEnabled).toBe(true);
  });
});
