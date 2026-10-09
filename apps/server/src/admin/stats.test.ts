import { answers, assignments, blocks, questions } from '@human-msg/db';
import { createTestDatabase, type TestDatabase } from '@human-msg/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAdminHarness, type AdminHarness } from './testing';

let testDb: TestDatabase;
let h: AdminHarness;

beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(() => testDb.close());
beforeEach(async () => {
  await testDb.reset();
  h = await createAdminHarness(testDb);
});

const T0 = new Date('2026-05-10T10:00:00Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const FUTURE = new Date('2030-01-01T00:00:00Z');

async function ask(
  authorId: string,
  status: 'queued' | 'assigned' | 'answered' | 'expired',
  options: { createdAt?: Date; answeredAt?: Date } = {},
) {
  const [row] = await testDb.db
    .insert(questions)
    .values({
      authorId,
      text: `q ${Math.random()}`,
      status,
      expiresAt: FUTURE,
      createdAt: options.createdAt ?? T0,
      ...(status === 'answered' && { answeredAt: options.answeredAt ?? at(10) }),
    })
    .returning();
  return row!;
}
const handOver = (
  questionId: string,
  receiverId: string,
  outcome: 'answered' | 'timed_out' | 'skipped' | 'reported' | 'undeliverable' | null,
) =>
  testDb.db.insert(assignments).values({
    questionId,
    receiverId,
    assignedAt: T0,
    deadlineAt: at(30),
    ...(outcome && { outcome, endedAt: at(5) }),
  });

describe('GET /admin/api/stats', () => {
  it('needs the back office session', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/admin/api/stats' });
    expect(response.statusCode).toBe(401);
  });

  it('is all zero on an empty system, with no share and no average', async () => {
    const stats = (await h.get('/admin/api/stats')).json();
    expect(stats).toEqual({
      questions: {
        total: 0,
        queued: 0,
        assigned: 0,
        answered: 0,
        expired: 0,
        expiredShare: null,
        answeredByStaff: 0,
      },
      averageSecondsToAnswer: null,
      assignments: {
        total: 0,
        active: 0,
        answered: 0,
        skipped: 0,
        timedOut: 0,
        reported: 0,
        undeliverable: 0,
      },
      complaints: 0,
      queueSize: 0,
    });
  });

  it('counts questions, the expired share, time to answer, outcomes, complaints and the queue', async () => {
    const authors = [];
    for (let i = 0; i < 7; i++) authors.push(await h.createUser());
    const [a, b, c, d, e, f, g] = authors as [
      (typeof authors)[number],
      (typeof authors)[number],
      (typeof authors)[number],
      (typeof authors)[number],
      (typeof authors)[number],
      (typeof authors)[number],
      (typeof authors)[number],
    ];
    const helper = await h.createUser({ alias: 'Helper' });
    const staff = await h.createUser({ alias: 'Staffer', isStaff: true });

    // Two answered by people: after 10 and 20 minutes → average 15 minutes
    const q1 = await ask(a.id, 'answered', { answeredAt: at(10) });
    const q2 = await ask(b.id, 'answered', { answeredAt: at(20) });
    await testDb.db.insert(answers).values([
      { questionId: q1.id, authorId: helper.id, text: 'one' },
      { questionId: q2.id, authorId: helper.id, text: 'two' },
    ]);
    // Answered by the back office after 600 minutes: counted, but not in the average
    const q3 = await ask(c.id, 'answered', { answeredAt: at(600) });
    await testDb.db.insert(answers).values({ questionId: q3.id, authorId: staff.id, text: 'late' });
    // Expired
    const q4 = await ask(d.id, 'expired');
    // In progress: left out of the share
    const q5 = await ask(e.id, 'assigned');
    await ask(f.id, 'queued');
    await ask(g.id, 'queued');

    await handOver(q1.id, helper.id, 'answered');
    await handOver(q4.id, helper.id, 'timed_out');
    await handOver(q4.id, a.id, 'skipped');
    await handOver(q4.id, b.id, 'reported');
    await handOver(q4.id, c.id, 'undeliverable');
    await handOver(q5.id, d.id, null);
    await testDb.db
      .insert(blocks)
      .values({ authorId: d.id, receiverId: b.id, reportedBy: b.id, questionId: q4.id });

    const stats = (await h.get('/admin/api/stats')).json();
    expect(stats.questions).toEqual({
      total: 7,
      queued: 2,
      assigned: 1,
      answered: 3,
      expired: 1,
      expiredShare: 0.25,
      answeredByStaff: 1,
    });
    expect(stats.averageSecondsToAnswer).toBe(15 * 60);
    expect(stats.assignments).toEqual({
      total: 6,
      active: 1,
      answered: 1,
      skipped: 1,
      timedOut: 1,
      reported: 1,
      undeliverable: 1,
    });
    expect(stats.complaints).toBe(1);
    expect(stats.queueSize).toBe(2);
  });

  it('limits to a period by the time of asking: from is included, to is not', async () => {
    const a = await h.createUser();
    const b = await h.createUser();
    const c = await h.createUser();
    await ask(a.id, 'expired', { createdAt: at(0) });
    await ask(b.id, 'expired', { createdAt: at(60) });
    await ask(c.id, 'queued', { createdAt: at(120) });

    const stats = (
      await h.get(`/admin/api/stats?from=${at(60).toISOString()}&to=${at(120).toISOString()}`)
    ).json();
    expect(stats.questions.total).toBe(1);
    expect(stats.questions.expired).toBe(1);
    // The queue is how it is now, not tied to the period
    expect(stats.queueSize).toBe(1);
  });

  it('leaves test users out unless asked', async () => {
    const real = await h.createUser();
    const tester = await h.createUser({ isTest: true });
    await ask(real.id, 'expired');
    await ask(tester.id, 'queued');

    const without = (await h.get('/admin/api/stats')).json();
    expect(without.questions.total).toBe(1);
    expect(without.queueSize).toBe(0);
    const withTest = (await h.get('/admin/api/stats?includeTest=true')).json();
    expect(withTest.questions.total).toBe(2);
    expect(withTest.queueSize).toBe(1);
  });

  it('refuses a malformed query', async () => {
    for (const query of ['from=yesterday', 'includeTest=maybe']) {
      expect((await h.get(`/admin/api/stats?${query}`)).statusCode).toBe(400);
    }
  });
});
