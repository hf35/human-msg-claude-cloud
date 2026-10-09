import { answers, assignments, outbox, questions } from '@human-msg/db';
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

describe('POST /admin/api/questions/:id/staff-answer', () => {
  const answerUrl = (id: string) => `/admin/api/questions/${id}/staff-answer`;

  it('needs the back office session', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: answerUrl('00000000-0000-4000-8000-000000000000'),
      payload: { text: 'hello there' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('answers an expired question: a normal answer by a staff user, delivered to the author', async () => {
    const author = await h.createUser({ alias: 'Waiting', locale: 'en' });
    const q = await question(author.id, 'Anyone out there?', 'expired');

    const response = await h.send('POST', answerUrl(q.id), { text: '  We hear you.  ' });
    expect(response.statusCode).toBe(201);

    const [item] = (await h.get('/admin/api/questions?status=answered')).json().items;
    expect(item).toMatchObject({ id: q.id, status: 'answered', answer: { text: 'We hear you.' } });
    // The responder is a staff user with an alias like any other, in the author's language
    expect(item.answer.responderAlias).not.toMatch(/[А-Яа-яЁё]/);
    const [responder] = (await h.get('/admin/api/users?isStaff=true')).json().items;
    expect(responder.alias).toBe(item.answer.responderAlias);

    // The author gets the usual event, without any mark of the team
    const [event] = await testDb.db.select().from(outbox);
    expect(event).toMatchObject({ userId: author.id, type: 'answer.received' });
    expect(event!.payload).toEqual({
      questionId: q.id,
      questionText: 'Anyone out there?',
      answerText: 'We hear you.',
      responderAlias: responder.alias,
    });
  });

  it('refuses a second answer and answers to questions that are not expired', async () => {
    const author = await h.createUser();
    const other = await h.createUser();
    const expired = await question(author.id, 'Old', 'expired');
    const queued = await question(other.id, 'Fresh', 'queued');

    expect((await h.send('POST', answerUrl(expired.id), { text: 'First reply' })).statusCode).toBe(
      201,
    );
    const again = await h.send('POST', answerUrl(expired.id), { text: 'Second reply' });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: 'not_expired' });
    expect((await h.send('POST', answerUrl(queued.id), { text: 'Too early' })).statusCode).toBe(
      409,
    );
    expect(await testDb.db.select().from(answers)).toHaveLength(1);
  });

  it('refuses bad text, unknown questions and malformed bodies', async () => {
    const author = await h.createUser();
    const q = await question(author.id, 'Old', 'expired');

    const empty = await h.send('POST', answerUrl(q.id), { text: '   ' });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error).toBe('empty');
    expect((await h.send('POST', answerUrl(q.id), { text: 'x' })).json().error).toBe('tooShort');
    expect((await h.send('POST', answerUrl(q.id), { text: 'x'.repeat(2001) })).json().error).toBe(
      'tooLong',
    );
    expect((await h.send('POST', answerUrl(q.id), {})).statusCode).toBe(400);
    expect(
      (await h.send('POST', answerUrl('00000000-0000-4000-8000-000000000000'), { text: 'hello' }))
        .statusCode,
    ).toBe(404);
    expect((await h.send('POST', answerUrl('nope'), { text: 'hello' })).statusCode).toBe(404);
    expect(await testDb.db.select().from(answers)).toHaveLength(0);
  });
});
