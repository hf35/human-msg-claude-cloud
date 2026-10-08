import { answers, assignments, outbox, questions, users, type NewUser } from '@human-msg/db';
import { createManualTime } from '@human-msg/db';
import { createTestDatabase, type TestDatabase } from '@human-msg/db/testing';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCore } from './core';
import { handleIncomingText } from './incoming';
import { skipAssignment } from './questions';
import { staffAnswer } from './staff';
import { tick } from './worker-loop';

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
      alias: `Life ${counter}`,
      channel: 'telegram',
      telegramId: 1000 + counter,
      ...values,
    })
    .returning();
  return user!;
}

const send = (userId: string, text: string) =>
  core().run((ctx) => handleIncomingText(ctx, userId, text));
const MINUTE = 60 * 1000;
const eventsOf = async (userId: string) =>
  (
    await testDb.db.select().from(outbox).where(eq(outbox.userId, userId)).orderBy(asc(outbox.id))
  ).map((e) => ({ type: e.type, payload: e.payload as Record<string, unknown> }));

describe('life of a question', () => {
  it('question → timeout → skip → answer', async () => {
    const author = await createUser({ receivingEnabled: false });
    const first = await createUser();
    const second = await createUser();

    const asked = await send(author.id, 'What is worth learning?');
    expect(asked).toMatchObject({ ok: true, value: { kind: 'asked', status: 'assigned' } });
    const questionId = (asked as { value: { questionId: string } }).value.questionId;
    const currentReceiver = async () => {
      const active = (
        await testDb.db.select().from(assignments).where(eq(assignments.questionId, questionId))
      ).find((a) => a.outcome === null);
      return active?.receiverId;
    };

    // The first receiver stays silent and misses the deadline
    const firstReceiver = (await currentReceiver())!;
    time.advance(26 * MINUTE);
    await tick(core());
    time.advance(5 * MINUTE);
    await tick(core());
    // The question moved on to the other receiver
    const secondReceiver = (await currentReceiver())!;
    expect(secondReceiver).not.toBe(firstReceiver);
    expect([first.id, second.id]).toContain(secondReceiver);

    // The second receiver skips; nobody else is available, so the question waits in the queue
    expect(await core().run((ctx) => skipAssignment(ctx, secondReceiver))).toMatchObject({
      ok: true,
    });
    await tick(core());
    expect(await currentReceiver()).toBeUndefined();
    expect((await testDb.db.select().from(questions))[0]!.status).toBe('queued');

    // A new user appears; the worker hands the queued question over and the user answers
    const third = await createUser();
    await tick(core());
    expect(await currentReceiver()).toBe(third.id);
    const answered = await send(third.id, 'Anything that makes you curious');
    expect(answered).toMatchObject({ ok: true, value: { kind: 'answered', questionId } });

    const history = await testDb.db
      .select()
      .from(assignments)
      .where(eq(assignments.questionId, questionId))
      .orderBy(asc(assignments.assignedAt));
    expect(history.map((a) => a.outcome)).toEqual(['timed_out', 'skipped', 'answered']);
    expect((await testDb.db.select().from(questions))[0]!.status).toBe('answered');
    const [answer] = await testDb.db.select().from(answers);
    expect(answer).toMatchObject({ authorId: third.id, text: 'Anything that makes you curious' });

    const events = await eventsOf(author.id);
    expect(events.map((e) => e.type)).toEqual(['answer.received']);
    expect(events[0]!.payload).toMatchObject({
      questionText: 'What is worth learning?',
      answerText: 'Anything that makes you curious',
    });
    expect((await eventsOf(firstReceiver)).map((e) => e.type)).toEqual([
      'question.assigned',
      'assignment.reminder',
      'assignment.expired',
    ]);

    // The worker has nothing left to do
    expect(await tick(core())).toEqual({ timedOut: 0, reminded: 0, expired: 0, assigned: 0 });
  });

  it('question → expiry → answer from the back office', async () => {
    const author = await createUser({ receivingEnabled: false });
    const asked = await send(author.id, 'Is anybody there?');
    const questionId = (asked as { value: { questionId: string } }).value.questionId;
    expect((await testDb.db.select().from(questions))[0]!.status).toBe('queued');

    // Nobody can answer before the lifetime ends; the author is told
    time.advance(3 * 60 * MINUTE + MINUTE);
    expect(await tick(core())).toMatchObject({ expired: 1 });
    expect((await testDb.db.select().from(questions))[0]!.status).toBe('expired');
    expect((await eventsOf(author.id)).map((e) => e.type)).toEqual([
      'question.queued',
      'question.expired',
    ]);

    // The author may ask again, but first the team answers the old question
    const staff = await core().run((ctx) => staffAnswer(ctx, questionId, 'Yes, we are here'));
    expect(staff).toMatchObject({ ok: true });
    expect((await testDb.db.select().from(questions))[0]!.status).toBe('answered');
    const [answer] = await testDb.db.select().from(answers);
    expect(answer!.text).toBe('Yes, we are here');
    const [responder] = await testDb.db.select().from(users).where(eq(users.id, answer!.authorId));
    expect(responder).toMatchObject({ isStaff: true });

    const events = await eventsOf(author.id);
    expect(events.at(-1)).toMatchObject({
      type: 'answer.received',
      payload: { questionText: 'Is anybody there?', answerText: 'Yes, we are here' },
    });
    expect(await tick(core())).toEqual({ timedOut: 0, reminded: 0, expired: 0, assigned: 0 });
  });
});
