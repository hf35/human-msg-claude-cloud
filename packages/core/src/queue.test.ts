import { assignments, blocks, questions, users, webConnections, type NewUser } from '@human-msg/db';
import { createManualTime } from '@human-msg/db';
import { createTestDatabase, type TestDatabase } from '@human-msg/db/testing';
import { DEFAULT_SETTINGS } from '@human-msg/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connect, setReceiving } from './availability';
import { createCore } from './core';
import { assignFromQueue } from './queue';
import { ok } from './result';

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
      alias: `Queue ${counter}`,
      channel: 'telegram',
      telegramId: 4000 + counter,
      ...values,
    })
    .returning();
  return user!;
}

let queuedAt = 0;
/** A queued question; `age` orders them: a larger age is an older question. */
async function queuedQuestion(authorValues: Partial<NewUser> = {}, age = 0) {
  const author = await createUser(authorValues);
  queuedAt++;
  const [question] = await testDb.db
    .insert(questions)
    .values({
      authorId: author.id,
      text: `Question ${queuedAt}`,
      createdAt: new Date(Date.now() - age * 1000),
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    .returning();
  return { author, question: question! };
}

const take = async (userId: string) => {
  const result = await core().run(async (ctx) => ok(await assignFromQueue(ctx, userId)));
  return result.ok ? result.value : undefined;
};
const activeAssignments = (userId: string) =>
  testDb.db.select().from(assignments).where(eq(assignments.receiverId, userId));

describe('assignFromQueue', () => {
  it('gives the oldest of two queued questions', async () => {
    const newer = await queuedQuestion({}, 10);
    const older = await queuedQuestion({}, 100);
    const user = await createUser();
    expect(await take(user.id)).toBe(older.question.id);
    const [assignment] = await activeAssignments(user.id);
    expect(assignment).toMatchObject({ questionId: older.question.id, outcome: null });
    const [row] = await testDb.db
      .select()
      .from(questions)
      .where(eq(questions.id, newer.question.id));
    expect(row!.status).toBe('queued');
  });

  it('returns nothing when the queue is empty', async () => {
    expect(await take((await createUser()).id)).toBeUndefined();
  });

  it('does nothing for a user who cannot receive: unavailable, busy, on cooldown, staff', async () => {
    await queuedQuestion();
    const dnd = await createUser({ receivingEnabled: false });
    const blocked = await createUser({ botBlockedAt: new Date() });
    const web = await createUser({ channel: 'web', telegramId: null, googleSub: 'g-off' });
    const cooling = await createUser({ cooldownUntil: new Date(Date.now() + 600_000) });
    const staff = await createUser({ isStaff: true });
    for (const user of [dnd, blocked, web, cooling, staff]) {
      expect(await take(user.id)).toBeUndefined();
    }
    const busy = await createUser();
    await queuedQuestion();
    expect(await take(busy.id)).toBeDefined();
    expect(await take(busy.id)).toBeUndefined();
  });

  it('takes a question once the cooldown has ended', async () => {
    const { question } = await queuedQuestion();
    const user = await createUser({ cooldownUntil: new Date(Date.now() + 600_000) });
    expect(await take(user.id)).toBeUndefined();
    time.advance(601_000);
    expect(await take(user.id)).toBe(question.id);
  });

  it('skips questions that do not fit and takes the next suitable one', async () => {
    const user = await createUser();
    const own = await queuedQuestion({}, 500);
    await testDb.db
      .update(questions)
      .set({ authorId: user.id })
      .where(eq(questions.id, own.question.id));
    await queuedQuestion({ isTest: true }, 400); // other pool
    const expired = await queuedQuestion({}, 300);
    await testDb.db
      .update(questions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(questions.id, expired.question.id));
    const seen = await queuedQuestion({}, 200);
    await testDb.db.insert(assignments).values({
      questionId: seen.question.id,
      receiverId: user.id,
      deadlineAt: new Date(Date.now() + 1000),
      outcome: 'skipped',
      endedAt: new Date(),
    });
    const blockedFor = await queuedQuestion({}, 150);
    await testDb.db.insert(blocks).values({
      authorId: blockedFor.author.id,
      receiverId: user.id,
      reportedBy: user.id,
      questionId: blockedFor.question.id,
    });
    const good = await queuedQuestion({}, 100);

    expect(await take(user.id)).toBe(good.question.id);
  });

  it('keeps test users with test questions', async () => {
    const live = await queuedQuestion();
    const test = await queuedQuestion({ isTest: true });
    const testUser = await createUser({ isTest: true });
    expect(await take(testUser.id)).toBe(test.question.id);
    expect(live.question.id).not.toBe(test.question.id);
  });

  it('ignores answered and assigned questions', async () => {
    const answered = await queuedQuestion();
    await testDb.db
      .update(questions)
      .set({ status: 'answered', answeredAt: new Date() })
      .where(eq(questions.id, answered.question.id));
    const assigned = await queuedQuestion();
    await testDb.db
      .update(questions)
      .set({ status: 'assigned' })
      .where(eq(questions.id, assigned.question.id));
    expect(await take((await createUser()).id)).toBeUndefined();
  });

  it('gives one queued question to only one of two users taking at once', async () => {
    const { question } = await queuedQuestion();
    const a = await createUser();
    const b = await createUser();
    const results = await Promise.all([take(a.id), take(b.id)]);
    expect(results.filter((id) => id === question.id)).toHaveLength(1);
    expect(await testDb.db.select().from(assignments)).toHaveLength(1);
  });
});

describe('triggers', () => {
  it('connect: a web user who connects gets the oldest queued question', async () => {
    const { question } = await queuedQuestion();
    const web = await createUser({ channel: 'web', telegramId: null, googleSub: 'g-conn' });
    await core().run((ctx) => connect(ctx, web.id, 's1'));
    const [assignment] = await activeAssignments(web.id);
    expect(assignment).toMatchObject({ questionId: question.id });
    expect(DEFAULT_SETTINGS.ANSWER_TIMEOUT).toBeGreaterThan(0);
  });

  it('connect: a second connection does not give a second question', async () => {
    await queuedQuestion();
    await queuedQuestion();
    const web = await createUser({ channel: 'web', telegramId: null, googleSub: 'g-two' });
    await core().run((ctx) => connect(ctx, web.id, 's1'));
    await core().run((ctx) => connect(ctx, web.id, 's1'));
    expect(await activeAssignments(web.id)).toHaveLength(1);
    expect(await testDb.db.select().from(webConnections)).toHaveLength(2);
  });

  it('setReceiving(true): a Telegram user who turns "do not disturb" off gets a question', async () => {
    const { question } = await queuedQuestion();
    const user = await createUser({ receivingEnabled: false });
    await core().run((ctx) => setReceiving(ctx, user.id, true));
    expect((await activeAssignments(user.id))[0]).toMatchObject({ questionId: question.id });
  });

  it('setReceiving(false) takes nothing', async () => {
    await queuedQuestion();
    const user = await createUser({ receivingEnabled: false });
    await core().run((ctx) => setReceiving(ctx, user.id, false));
    expect(await activeAssignments(user.id)).toHaveLength(0);
  });
});
