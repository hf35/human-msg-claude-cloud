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

const BASE = '/admin/api/test-users';

async function newTestUser(locale?: 'ru' | 'en'): Promise<string> {
  const response = await h.send('POST', BASE, locale ? { locale } : {});
  expect(response.statusCode).toBe(201);
  return response.json().id;
}
const receiving = (id: string, receivingEnabled: boolean) =>
  h.send('PUT', `${BASE}/${id}/receiving`, { receivingEnabled });
const say = (id: string, text: string) => h.send('POST', `${BASE}/${id}/messages`, { text });

describe('creating test users', () => {
  it('needs the back office session', async () => {
    const response = await h.app.inject({ method: 'POST', url: BASE, payload: {} });
    expect(response.statusCode).toBe(401);
  });

  it('creates a test user with an alias in the chosen language, not yet available', async () => {
    const response = await h.send('POST', BASE, { locale: 'en' });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      isTest: true,
      isStaff: false,
      locale: 'en',
      receivingEnabled: false,
    });
    expect(response.json().alias).not.toMatch(/[А-Яа-яЁё]/);

    const list = (await h.get('/admin/api/users?isTest=true')).json();
    expect(list.total).toBe(1);
  });

  it('refuses an unknown language', async () => {
    expect((await h.send('POST', BASE, { locale: 'de' })).statusCode).toBe(400);
  });
});

describe('two test users', () => {
  it('exchange a question and an answer by the usual rules', async () => {
    const asker = await newTestUser('en');
    const answerer = await newTestUser('en');
    expect((await receiving(answerer, true)).statusCode).toBe(200);

    const asked = await say(asker, 'Is this thing on?');
    expect(asked.json()).toMatchObject({ kind: 'asked', status: 'assigned' });

    // The answerer sees the question, from the asker's alias
    const state = (await h.get(`${BASE}/${answerer}/state`)).json();
    expect(state.assignment).toMatchObject({ text: 'Is this thing on?' });
    expect((await h.get(`${BASE}/${asker}/state`)).json().pendingQuestion).toMatchObject({
      status: 'assigned',
    });

    const answered = await say(answerer, 'Loud and clear.');
    expect(answered.json()).toMatchObject({ kind: 'answered' });
    const [answer] = await testDb.db.select().from(answers);
    expect(answer).toMatchObject({ authorId: answerer, text: 'Loud and clear.' });
    const events = await testDb.db.select().from(outbox);
    expect(events.map((e) => e.type)).toContain('answer.received');
  });

  it('a question waits in the queue until the second user becomes available', async () => {
    const asker = await newTestUser();
    const answerer = await newTestUser();

    expect((await say(asker, 'Anybody here today?')).json()).toMatchObject({ status: 'queued' });
    await receiving(answerer, true);

    const state = (await h.get(`${BASE}/${answerer}/state`)).json();
    expect(state.assignment).toMatchObject({ text: 'Anybody here today?' });
  });

  it('skipping hands the question on and rests the skipper', async () => {
    const asker = await newTestUser();
    const first = await newTestUser();
    await receiving(first, true);
    await say(asker, 'Who wants this one?');

    const skipped = await h.send('POST', `${BASE}/${first}/skip`);
    expect(skipped.statusCode).toBe(200);
    const [assignment] = await testDb.db.select().from(assignments);
    expect(assignment).toMatchObject({ outcome: 'skipped' });
    expect((await testDb.db.select().from(questions))[0]).toMatchObject({ status: 'queued' });
    // Nothing left to skip
    expect((await h.send('POST', `${BASE}/${first}/skip`)).statusCode).toBe(409);
  });

  it('are refused by the usual rules: a second question while waiting, bad text', async () => {
    const asker = await newTestUser();
    await say(asker, 'First question');
    const second = await say(asker, 'Second question');
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: 'awaitingAnswer' });
    expect((await say(asker, '   ')).statusCode).toBe(400);
  });
});

describe('the pools do not mix', () => {
  it('a real user does not get the question of a test user', async () => {
    const asker = await newTestUser();
    const real = await h.createUser({ alias: 'Real Person' });
    expect(real.receivingEnabled).toBe(true);

    expect((await say(asker, 'Is anybody real?')).json()).toMatchObject({ status: 'queued' });
    expect(await testDb.db.select().from(assignments)).toHaveLength(0);
  });

  it('a test user does not get the question of a real user', async () => {
    const tester = await newTestUser();
    await receiving(tester, true);
    const real = await h.createUser();
    await testDb.db
      .insert(questions)
      .values({ authorId: real.id, text: 'Real question', expiresAt: new Date('2030-01-01') });

    // Even when the test user turns availability off and on again, the queue is not theirs
    await receiving(tester, false);
    await receiving(tester, true);
    expect(await testDb.db.select().from(assignments)).toHaveLength(0);
    expect((await h.get(`${BASE}/${tester}/state`)).json().assignment).toBeNull();
  });
});

describe('real users are never acted for', () => {
  it('refuses every action on a user who is not a test user', async () => {
    const real = await h.createUser();
    const staff = await h.createUser({ isStaff: true });
    for (const id of [real.id, staff.id]) {
      expect((await say(id, 'Sent in your name')).statusCode).toBe(403);
      expect((await receiving(id, false)).statusCode).toBe(403);
      expect((await h.send('POST', `${BASE}/${id}/skip`)).statusCode).toBe(403);
      expect((await h.get(`${BASE}/${id}/state`)).statusCode).toBe(403);
    }
    expect(await testDb.db.select().from(questions)).toHaveLength(0);
  });

  it('answers 404 for an unknown or malformed id', async () => {
    const unknown = '00000000-0000-4000-8000-000000000000';
    expect((await say(unknown, 'Hello there')).statusCode).toBe(404);
    expect((await say('nope', 'Hello there')).statusCode).toBe(404);
    expect((await receiving(unknown, true)).statusCode).toBe(404);
  });
});
