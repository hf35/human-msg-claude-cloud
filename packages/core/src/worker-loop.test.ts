import { assignments, outbox, questions, users, type NewUser } from '@human-msg/db';
import { createManualTime } from '@human-msg/db';
import { createTestDatabase, type TestDatabase } from '@human-msg/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCore, type Core } from './core';
import { askQuestion } from './questions';
import { startWorker, tick } from './worker-loop';

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
      alias: `Loop ${counter}`,
      channel: 'telegram',
      telegramId: 3000 + counter,
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
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const countOf = async (type: string) =>
  (await testDb.db.select().from(outbox)).filter((e) => e.type === type).length;

describe('tick', () => {
  it('several passes in a row are idempotent', async () => {
    const author = await createUser();
    await createUser();
    await ask(author.id);
    time.advance(26 * MINUTE);

    expect(await tick(core())).toMatchObject({ reminded: 1, timedOut: 0 });
    expect(await tick(core())).toEqual({ timedOut: 0, reminded: 0, expired: 0, assigned: 0 });
    time.advance(5 * MINUTE);
    expect(await tick(core())).toMatchObject({ timedOut: 1 });
    expect(await tick(core())).toEqual({ timedOut: 0, reminded: 0, expired: 0, assigned: 0 });

    expect(await countOf('assignment.reminder')).toBe(1);
    expect(await countOf('assignment.expired')).toBe(1);
    expect(await testDb.db.select().from(assignments)).toHaveLength(1);
  });

  it('two workers running at once do not handle the same record twice', async () => {
    for (let i = 0; i < 5; i++) {
      await testDb.reset();
      time.reset();
      const authors = [];
      for (let j = 0; j < 4; j++) authors.push(await createUser({ receivingEnabled: false }));
      for (let j = 0; j < 4; j++) await createUser();
      for (const author of authors) await ask(author.id);
      time.advance(26 * MINUTE);

      const first = await Promise.all([tick(core()), tick(core())]);
      expect(first.reduce((sum, r) => sum + r.reminded, 0)).toBe(4);
      time.advance(5 * MINUTE);
      const second = await Promise.all([tick(core()), tick(core()), tick(core())]);
      expect(second.reduce((sum, r) => sum + r.timedOut, 0)).toBe(4);

      expect(await countOf('assignment.reminder')).toBe(4);
      expect(await countOf('assignment.expired')).toBe(4);
      const history = await testDb.db.select().from(assignments);
      expect(history.filter((a) => a.outcome === 'timed_out')).toHaveLength(4);
      expect((await testDb.db.select().from(questions)).every((q) => q.status !== 'answered')).toBe(
        true,
      );
    }
  });

  it('expires questions and keeps the queue moving', async () => {
    const author = await createUser({ receivingEnabled: false });
    await ask(author.id);
    time.advance(3 * 60 * MINUTE + MINUTE);
    expect(await tick(core())).toMatchObject({ expired: 1, assigned: 0 });
    expect(await countOf('question.expired')).toBe(1);
  });
});

describe('startWorker', () => {
  it('runs passes on its own and stops for good', async () => {
    const author = await createUser();
    await createUser();
    await ask(author.id);
    time.advance(26 * MINUTE);

    const worker = startWorker({ core: core(), intervalMs: 10 });
    for (let i = 0; i < 100 && (await countOf('assignment.reminder')) === 0; i++) await sleep(20);
    await worker.stop();
    expect(await countOf('assignment.reminder')).toBe(1);

    time.advance(5 * MINUTE);
    await sleep(60);
    expect(await countOf('assignment.expired')).toBe(0);
  });

  it('never overlaps passes of one worker, however slow they are', async () => {
    const inner = core();
    let running = 0;
    let maxRunning = 0;
    let started = 0;
    const slow: Core = {
      async run(command) {
        started++;
        running++;
        maxRunning = Math.max(maxRunning, running);
        await sleep(15);
        try {
          return await inner.run(command);
        } finally {
          running--;
        }
      },
    };
    const worker = startWorker({ core: slow, intervalMs: 1 });
    await sleep(300);
    await worker.stop();
    expect(started).toBeGreaterThan(4);
    expect(maxRunning).toBe(1);
    const after = started;
    await sleep(60);
    expect(started).toBe(after);
  });

  it('survives a failing pass and reports it', async () => {
    const errors: unknown[] = [];
    const broken: Core = {
      run: () => Promise.reject(new Error('database is down')),
    };
    const worker = startWorker({ core: broken, intervalMs: 5, onError: (e) => errors.push(e) });
    await sleep(100);
    await worker.stop();
    expect(errors.length).toBeGreaterThan(1);
  });
});
