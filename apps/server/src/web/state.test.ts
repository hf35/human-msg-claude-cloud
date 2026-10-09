import { connect, handleIncomingText } from '@human-msg/core';
import { createManualTime } from '@human-msg/db';
import { createTestDatabase, type TestDatabase } from '@human-msg/db/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createWebHarness, type WebHarness } from './testing';

let testDb: TestDatabase;
let web: WebHarness | undefined;
const time = createManualTime();

beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(() => testDb.close());
beforeEach(async () => {
  time.reset();
  await testDb.reset();
});
afterEach(async () => {
  await web?.app.close();
  web = undefined;
});

const harness = async () => (web = await createWebHarness(testDb, time));
const send = (h: WebHarness, userId: string, text: string) =>
  h.core.run((ctx) => handleIncomingText(ctx, userId, text));
const online = (h: WebHarness, userId: string) =>
  h.core.run((ctx) => connect(ctx, userId, 'test-server'));
const get = (h: WebHarness, url: string, cookies?: Record<string, string>) =>
  h.app.inject({ method: 'GET', url, ...(cookies && { cookies }) });

describe.each(['/api/me', '/api/state'])('GET %s', (url) => {
  it('answers 401 without a session', async () => {
    const h = await harness();
    const response = await get(h, url);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized' });
  });
});

describe('a free user', () => {
  it('has no question and no pause', async () => {
    const h = await harness();
    const { cookies } = await h.signIn('Green Rabbit');

    const me = await get(h, '/api/me', cookies);
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({
      alias: 'Green Rabbit',
      locale: 'ru',
      awaitingAnswer: false,
      busy: false,
      cooldownUntil: null,
      questionLimit: { limit: 10, used: 0, remaining: 10 },
      messageMaxLength: 2000,
    });

    const state = await get(h, '/api/state', cookies);
    expect(state.json()).toEqual({ assignment: null, pendingQuestion: null });
  });
});

describe('a user awaiting an answer', () => {
  it('sees their queued question and the used part of the limit', async () => {
    const h = await harness();
    const { user, cookies } = await h.signIn();
    await send(h, user.id, 'Is anybody there?');

    const me = (await get(h, '/api/me', cookies)).json();
    expect(me).toMatchObject({
      awaitingAnswer: true,
      busy: false,
      questionLimit: { limit: 10, used: 1, remaining: 9 },
    });

    const { assignment, pendingQuestion } = (await get(h, '/api/state', cookies)).json();
    expect(assignment).toBeNull();
    expect(pendingQuestion).toMatchObject({ text: 'Is anybody there?', status: 'queued' });
    expect(Date.parse(pendingQuestion.expiresAt)).toBeGreaterThan(
      Date.parse(pendingQuestion.createdAt),
    );
  });
});

describe('a busy user', () => {
  it('sees the assigned question with its author alias and deadline, not the author id', async () => {
    const h = await harness();
    const author = await h.signIn('Blue Fox');
    const receiver = await h.signIn('Green Rabbit');
    await online(h, receiver.user.id);
    await send(h, author.user.id, 'What is your favourite colour?');

    const me = (await get(h, '/api/me', receiver.cookies)).json();
    expect(me).toMatchObject({ busy: true, awaitingAnswer: false });

    const response = await get(h, '/api/state', receiver.cookies);
    const { assignment, pendingQuestion } = response.json();
    expect(pendingQuestion).toBeNull();
    expect(assignment).toMatchObject({
      text: 'What is your favourite colour?',
      authorAlias: 'Blue Fox',
    });
    expect(Date.parse(assignment.deadlineAt)).toBeGreaterThan(Date.parse(assignment.assignedAt));
    expect(response.body).not.toContain(author.user.id);

    // The author sees their question as assigned, but not to whom
    const authorState = await get(h, '/api/state', author.cookies);
    expect(authorState.json().pendingQuestion).toMatchObject({ status: 'assigned' });
    expect(authorState.body).not.toContain('Green Rabbit');
  });

  it('can be busy and awaiting an answer at the same time', async () => {
    const h = await harness();
    const author = await h.signIn();
    const receiver = await h.signIn();
    await online(h, receiver.user.id);
    await send(h, receiver.user.id, 'My own question');
    await send(h, author.user.id, 'A question for you');

    const me = (await get(h, '/api/me', receiver.cookies)).json();
    expect(me).toMatchObject({ busy: true, awaitingAnswer: true });
    const state = (await get(h, '/api/state', receiver.cookies)).json();
    expect(state.assignment).toMatchObject({ text: 'A question for you' });
    expect(state.pendingQuestion).toMatchObject({ text: 'My own question' });
  });

  it('is free again after answering, and then has a pause', async () => {
    const h = await harness();
    const author = await h.signIn();
    const receiver = await h.signIn();
    await online(h, receiver.user.id);
    await send(h, author.user.id, 'Question');
    await send(h, receiver.user.id, 'Answer');

    const me = (await get(h, '/api/me', receiver.cookies)).json();
    expect(me.busy).toBe(false);
    expect(me.cooldownUntil).not.toBeNull();
    // The author's question is answered, so nothing is pending any more
    expect((await get(h, '/api/state', author.cookies)).json().pendingQuestion).toBeNull();

    // The pause runs out
    time.advance(6 * 60 * 1000);
    expect((await get(h, '/api/me', receiver.cookies)).json().cooldownUntil).toBeNull();
  });
});

describe('a user in a pause', () => {
  it('sees when it ends only while it lasts', async () => {
    const h = await harness();
    const { user, cookies } = await h.signIn();
    await testDb.pool.query(
      `UPDATE users SET cooldown_until = now() + interval '1 hour' WHERE id = $1`,
      [user.id],
    );
    const me = (await get(h, '/api/me', cookies)).json();
    expect(Date.parse(me.cooldownUntil)).toBeGreaterThan(Date.now());

    time.advance(2 * 3600_000);
    expect((await get(h, '/api/me', cookies)).json().cooldownUntil).toBeNull();
  });
});

describe('the question limit', () => {
  it('shrinks with every question and never goes below zero', async () => {
    const h = await harness();
    const { user, cookies } = await h.signIn();
    // A pending question blocks the next one, so each is marked answered directly:
    // the test is about the counter only
    for (let i = 0; i < 3; i++) {
      await send(h, user.id, `Question number ${i}`);
      await testDb.pool.query(
        `UPDATE questions SET status = 'answered', answered_at = now() WHERE author_id = $1`,
        [user.id],
      );
    }
    const me = (await get(h, '/api/me', cookies)).json();
    expect(me.questionLimit).toEqual({ limit: 10, used: 3, remaining: 7 });
  });
});

describe('PATCH /api/me', () => {
  const patch = (h: WebHarness, payload: unknown, cookies?: Record<string, string>) =>
    h.app.inject({
      method: 'PATCH',
      url: '/api/me',
      payload: payload as object,
      ...(cookies && { cookies }),
    });

  it('requires a session', async () => {
    const h = await harness();
    expect((await patch(h, { locale: 'en' })).statusCode).toBe(401);
  });

  it('stores the language and keeps the alias', async () => {
    const h = await harness();
    const { user, cookies } = await h.signIn('Зелёный Кролик');
    const response = await patch(h, { locale: 'en' }, cookies);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ locale: 'en', alias: 'Зелёный Кролик' });
    const { rows } = await testDb.pool.query(`SELECT locale, alias FROM users WHERE id = $1`, [
      user.id,
    ]);
    expect(rows).toEqual([{ locale: 'en', alias: 'Зелёный Кролик' }]);
    expect((await get(h, '/api/me', cookies)).json().locale).toBe('en');
  });

  it.each([[{ locale: 'de' }], [{}], [{ locale: 1 }]])('refuses the body %j', async (body) => {
    const h = await harness();
    const { cookies } = await h.signIn();
    const response = await patch(h, body, cookies);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_request' });
  });
});
