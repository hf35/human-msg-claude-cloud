import { answers, assignments, questions } from '@human-msg/db';
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

const FUTURE = new Date('2030-01-01T00:00:00Z');
let day = 0;
async function question(
  authorId: string,
  text: string,
  status: 'queued' | 'assigned' | 'answered' | 'expired',
) {
  day++;
  const [row] = await testDb.db
    .insert(questions)
    .values({
      authorId,
      text,
      status,
      expiresAt: FUTURE,
      createdAt: new Date(`2026-04-${String(day).padStart(2, '0')}T10:00:00Z`),
      ...(status === 'answered' && { answeredAt: new Date('2026-04-30T10:00:00Z') }),
    })
    .returning();
  return row!;
}

describe('GET /admin/api/questions', () => {
  it('needs the back office session', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/admin/api/questions' });
    expect(response.statusCode).toBe(401);
  });

  it('lists questions newest first and filters by status', async () => {
    const author = await h.createUser({ alias: 'Asker' });
    const other = await h.createUser();
    await question(author.id, 'queued one', 'queued');
    await question(other.id, 'expired one', 'expired');
    await question(author.id, 'second expired', 'expired');

    const all = (await h.get('/admin/api/questions')).json();
    expect(all.total).toBe(3);
    expect(all.items.map((q: { text: string }) => q.text)).toEqual([
      'second expired',
      'expired one',
      'queued one',
    ]);

    const expired = (await h.get('/admin/api/questions?status=expired')).json();
    expect(expired.total).toBe(2);
    expect(expired.items.every((q: { status: string }) => q.status === 'expired')).toBe(true);
    expect(all.items[0]).toMatchObject({ authorAlias: 'Asker', answer: null, assignments: [] });
  });

  it('filters by author', async () => {
    const a = await h.createUser();
    const b = await h.createUser();
    await question(a.id, 'from a', 'queued');
    await question(b.id, 'from b', 'queued');
    const body = (await h.get(`/admin/api/questions?authorId=${b.id}`)).json();
    expect(body.items.map((q: { text: string }) => q.text)).toEqual(['from b']);
  });

  it('shows every assignment with its outcome, and the answer', async () => {
    const author = await h.createUser({ alias: 'Asker' });
    const slow = await h.createUser({ alias: 'Slow' });
    const quick = await h.createUser({ alias: 'Quick' });
    const q = await question(author.id, 'Who knows?', 'answered');
    await testDb.db.insert(assignments).values([
      {
        questionId: q.id,
        receiverId: slow.id,
        assignedAt: new Date('2026-04-01T10:00:00Z'),
        deadlineAt: new Date('2026-04-01T10:30:00Z'),
        endedAt: new Date('2026-04-01T10:30:00Z'),
        outcome: 'timed_out',
      },
      {
        questionId: q.id,
        receiverId: quick.id,
        assignedAt: new Date('2026-04-01T10:31:00Z'),
        deadlineAt: new Date('2026-04-01T11:01:00Z'),
        endedAt: new Date('2026-04-01T10:40:00Z'),
        outcome: 'answered',
      },
    ]);
    await testDb.db.insert(answers).values({ questionId: q.id, authorId: quick.id, text: 'I do' });

    const [item] = (await h.get('/admin/api/questions?status=answered')).json().items;
    expect(item.answer).toMatchObject({ text: 'I do', responderAlias: 'Quick' });
    expect(
      item.assignments.map((a: { receiverAlias: string; outcome: string }) => [
        a.receiverAlias,
        a.outcome,
      ]),
    ).toEqual([
      ['Slow', 'timed_out'],
      ['Quick', 'answered'],
    ]);
  });

  it('shows an active assignment with no outcome', async () => {
    const author = await h.createUser();
    const receiver = await h.createUser({ alias: 'Busy' });
    const q = await question(author.id, 'Pending', 'assigned');
    await testDb.db.insert(assignments).values({
      questionId: q.id,
      receiverId: receiver.id,
      deadlineAt: new Date(Date.now() + 60_000),
    });
    const [item] = (await h.get('/admin/api/questions?status=assigned')).json().items;
    expect(item.assignments[0]).toMatchObject({
      receiverAlias: 'Busy',
      outcome: null,
      endedAt: null,
    });
  });

  it('pages with limit and offset', async () => {
    const author = await h.createUser();
    for (let i = 0; i < 3; i++) {
      await h.createUser();
    }
    const users = [author, await h.createUser(), await h.createUser()];
    for (const user of users) await question(user.id, `q ${user.alias}`, 'queued');
    const page = (await h.get('/admin/api/questions?limit=2&offset=2')).json();
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(1);
  });

  it('refuses a malformed query', async () => {
    for (const query of ['status=done', 'authorId=x', 'limit=0']) {
      expect((await h.get(`/admin/api/questions?${query}`)).statusCode).toBe(400);
    }
  });
});
