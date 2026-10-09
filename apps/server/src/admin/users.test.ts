import { answers, questions } from '@human-msg/db';
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

describe('GET /admin/api/users', () => {
  it('needs the back office session', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/admin/api/users' });
    expect(response.statusCode).toBe(401);
  });

  it('is closed to a signed-in web user', async () => {
    const { cookies } = await h.signIn();
    const response = await h.app.inject({ method: 'GET', url: '/admin/api/users', cookies });
    expect(response.statusCode).toBe(401);
  });

  it('lists users newest first with counters and the total', async () => {
    const first = await h.createUser({ createdAt: new Date('2026-01-01T10:00:00Z') });
    const second = await h.createUser({ createdAt: new Date('2026-01-02T10:00:00Z') });
    await testDb.db
      .insert(questions)
      .values({ authorId: first.id, text: 'Why?', expiresAt: new Date('2030-01-01') });

    const body = (await h.get('/admin/api/users')).json();
    expect(body.total).toBe(2);
    expect(body.items.map((u: { id: string }) => u.id)).toEqual([second.id, first.id]);
    expect(body.items[1]).toMatchObject({ questionsAsked: 1, answersGiven: 0 });
    expect(body.items[0]).toMatchObject({ telegramId: second.telegramId, channel: 'telegram' });
  });

  it('filters by channel, test flag and staff flag', async () => {
    await h.createUser({ channel: 'telegram' });
    await h.createUser({ channel: 'web', telegramId: null, googleSub: 'g-1' });
    await h.createUser({ channel: 'web', telegramId: null, isTest: true });
    await h.createUser({ channel: 'web', telegramId: null, isStaff: true });
    const count = async (query: string) =>
      (await h.get(`/admin/api/users?${query}`)).json().total as number;

    expect(await count('channel=telegram')).toBe(1);
    expect(await count('channel=web')).toBe(3);
    expect(await count('isTest=true')).toBe(1);
    expect(await count('isTest=false')).toBe(3);
    expect(await count('isStaff=true')).toBe(1);
    expect(await count('channel=web&isTest=false&isStaff=false')).toBe(1);
  });

  it('filters by registration date: from is included, to is not', async () => {
    await h.createUser({ createdAt: new Date('2026-03-01T00:00:00Z') });
    await h.createUser({ createdAt: new Date('2026-03-02T00:00:00Z') });
    await h.createUser({ createdAt: new Date('2026-03-03T00:00:00Z') });

    const body = (
      await h.get(
        '/admin/api/users?createdFrom=2026-03-02T00:00:00Z&createdTo=2026-03-03T00:00:00Z',
      )
    ).json();
    expect(body.total).toBe(1);
    expect(body.items[0].createdAt).toBe('2026-03-02T00:00:00.000Z');
  });

  it('searches by part of the alias and treats % literally', async () => {
    await h.createUser({ alias: 'Green Rabbit' });
    await h.createUser({ alias: 'Blue Fox' });
    const total = async (search: string) =>
      (await h.get(`/admin/api/users?search=${encodeURIComponent(search)}`)).json().total;
    expect(await total('rabbit')).toBe(1);
    expect(await total('%')).toBe(0);
  });

  it('pages with limit and offset; the total stays the same', async () => {
    for (let i = 0; i < 5; i++) await h.createUser();
    const page = (await h.get('/admin/api/users?limit=2&offset=4')).json();
    expect(page.total).toBe(5);
    expect(page.items).toHaveLength(1);
  });

  it('refuses a malformed query', async () => {
    for (const query of ['channel=sms', 'limit=0', 'limit=1000', 'createdFrom=yesterday']) {
      expect((await h.get(`/admin/api/users?${query}`)).statusCode).toBe(400);
    }
  });
});

describe('GET /admin/api/users/:id', () => {
  it('returns the card', async () => {
    const user = await h.createUser({ alias: 'Card Owner' });
    const response = await h.get(`/admin/api/users/${user.id}`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: user.id,
      alias: 'Card Owner',
      receivingEnabled: true,
      botBlockedAt: null,
    });
  });

  it('answers 404 for an unknown or malformed id', async () => {
    expect((await h.get('/admin/api/users/00000000-0000-4000-8000-000000000000')).statusCode).toBe(
      404,
    );
    expect((await h.get('/admin/api/users/not-an-id')).statusCode).toBe(404);
  });
});

describe('GET /admin/api/users/:id/history', () => {
  it('shows what the user asked with the answer, and what they answered', async () => {
    const alice = await h.createUser({ alias: 'Alice' });
    const bob = await h.createUser({ alias: 'Bob' });
    const [q1] = await testDb.db
      .insert(questions)
      .values({
        authorId: alice.id,
        text: 'Alice asks',
        status: 'answered',
        answeredAt: new Date(),
        expiresAt: new Date('2030-01-01'),
        createdAt: new Date('2026-01-01T10:00:00Z'),
      })
      .returning();
    await testDb.db
      .insert(answers)
      .values({
        questionId: q1!.id,
        authorId: bob.id,
        text: 'Bob replies',
        createdAt: new Date('2026-01-01T11:00:00Z'),
      });
    await testDb.db.insert(questions).values({
      authorId: bob.id,
      text: 'Bob asks',
      expiresAt: new Date('2030-01-01'),
      createdAt: new Date('2026-01-02T10:00:00Z'),
    });

    const aliceHistory = (await h.get(`/admin/api/users/${alice.id}/history`)).json();
    expect(aliceHistory.items).toHaveLength(1);
    expect(aliceHistory.items[0]).toMatchObject({
      kind: 'question',
      text: 'Alice asks',
      answer: { text: 'Bob replies', responderAlias: 'Bob' },
    });

    const bobHistory = (await h.get(`/admin/api/users/${bob.id}/history`)).json();
    expect(bobHistory.items.map((i: { kind: string }) => i.kind)).toEqual(['question', 'answer']);
    expect(bobHistory.items[1]).toMatchObject({
      text: 'Bob replies',
      questionText: 'Alice asks',
      authorAlias: 'Alice',
    });
  });

  it('pages by cursor', async () => {
    const user = await h.createUser();
    for (let i = 0; i < 3; i++) {
      await testDb.db.insert(questions).values({
        authorId: user.id,
        text: `Q${i}`,
        status: 'expired',
        expiresAt: new Date('2030-01-01'),
        createdAt: new Date(`2026-02-0${i + 1}T10:00:00Z`),
      });
    }
    const first = (await h.get(`/admin/api/users/${user.id}/history?limit=2`)).json();
    expect(first.items.map((i: { text: string }) => i.text)).toEqual(['Q2', 'Q1']);
    const next = (
      await h.get(`/admin/api/users/${user.id}/history?limit=2&cursor=${first.nextCursor}`)
    ).json();
    expect(next.items.map((i: { text: string }) => i.text)).toEqual(['Q0']);
    expect(next.nextCursor).toBeNull();
  });

  it('answers 404 for an unknown user and 400 for a bad cursor', async () => {
    const user = await h.createUser();
    expect(
      (await h.get('/admin/api/users/00000000-0000-4000-8000-000000000000/history')).statusCode,
    ).toBe(404);
    expect((await h.get(`/admin/api/users/${user.id}/history?cursor=junk`)).statusCode).toBe(400);
  });
});
