import { connect } from '@human-msg/core';
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
type Cookies = Record<string, string>;
const post = (h: WebHarness, url: string, payload?: unknown, cookies?: Cookies) =>
  h.app.inject({
    method: 'POST',
    url,
    ...(payload !== undefined && { payload: payload as object }),
    ...(cookies && { cookies }),
  });
const say = (h: WebHarness, cookies: Cookies, text: unknown) =>
  post(h, '/api/messages', { text }, cookies);
const online = (h: WebHarness, userId: string) =>
  h.core.run((ctx) => connect(ctx, userId, 'test-server'));
const state = async (h: WebHarness, cookies: Cookies) =>
  (await h.app.inject({ method: 'GET', url: '/api/state', cookies })).json();

describe.each([
  ['/api/messages', { text: 'hello there' }],
  ['/api/assignment/skip', undefined],
  ['/api/reports', { target: 'question' }],
])('POST %s', (url, payload) => {
  it('requires a session', async () => {
    const h = await harness();
    const response = await post(h, url, payload);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized' });
  });
});

describe('POST /api/messages: a new question', () => {
  it('is queued when nobody is available', async () => {
    const h = await harness();
    const { cookies } = await h.signIn();
    const response = await say(h, cookies, 'Anybody out there?');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ kind: 'asked', status: 'queued' });
    expect((await state(h, cookies)).pendingQuestion).toMatchObject({
      text: 'Anybody out there?',
      status: 'queued',
    });
  });

  it('goes straight to an available receiver', async () => {
    const h = await harness();
    const author = await h.signIn();
    const receiver = await h.signIn('Green Rabbit');
    await online(h, receiver.user.id);
    const response = await say(h, author.cookies, 'What is your name?');
    expect(response.json()).toMatchObject({ kind: 'asked', status: 'assigned' });
    expect((await state(h, receiver.cookies)).assignment).toMatchObject({
      text: 'What is your name?',
    });
  });

  it('is trimmed of surrounding whitespace', async () => {
    const h = await harness();
    const { cookies } = await h.signIn();
    await say(h, cookies, '   padded question  \n');
    expect((await state(h, cookies)).pendingQuestion.text).toBe('padded question');
  });
});

describe('POST /api/messages: an answer', () => {
  it('is accepted from the receiver, even while they wait for their own answer', async () => {
    const h = await harness();
    const author = await h.signIn();
    const receiver = await h.signIn();
    await online(h, receiver.user.id);
    await say(h, receiver.cookies, 'My own question');
    const asked = (await say(h, author.cookies, 'Question for you')).json();

    const response = await say(h, receiver.cookies, 'My answer');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ kind: 'answered', questionId: asked.questionId });
    expect((await state(h, author.cookies)).pendingQuestion).toBeNull();
    // Their own question is still waiting
    expect((await state(h, receiver.cookies)).pendingQuestion).toMatchObject({
      text: 'My own question',
    });
  });
});

describe('POST /api/messages: refusals', () => {
  it.each([
    ['empty', '   ', 400],
    ['tooShort', 'a', 400],
    ['tooLong', 'x'.repeat(2001), 400],
    ['notText', 42, 400],
    ['notText', null, 400],
  ])('refuses %s text with a reason code', async (reason, text, status) => {
    const h = await harness();
    const { cookies } = await h.signIn();
    const response = await say(h, cookies, text);
    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({ error: reason });
    expect((await state(h, cookies)).pendingQuestion).toBeNull();
  });

  it('refuses a body without the text field as a malformed request', async () => {
    const h = await harness();
    const { cookies } = await h.signIn();
    const response = await post(h, '/api/messages', {}, cookies);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_request' });
  });

  it('refuses a JSON body that is not an object', async () => {
    const h = await harness();
    const { cookies } = await h.signIn();
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'content-type': 'application/json' },
      payload: '"just a string"',
      cookies,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_request' });
  });

  it('refuses a second question while the first has no answer', async () => {
    const h = await harness();
    const { cookies } = await h.signIn();
    await say(h, cookies, 'First question');
    const response = await say(h, cookies, 'Second question');
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'awaitingAnswer' });
  });

  it('refuses a question over the daily limit', async () => {
    const h = await harness();
    const { user, cookies } = await h.signIn();
    for (let i = 0; i < 10; i++) {
      expect((await say(h, cookies, `Question number ${i}`)).statusCode).toBe(200);
      await testDb.pool.query(
        `UPDATE questions SET status = 'answered', answered_at = now() WHERE author_id = $1`,
        [user.id],
      );
    }
    const response = await say(h, cookies, 'One too many');
    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({ error: 'dailyLimit' });
  });
});

describe('POST /api/assignment/skip', () => {
  it('frees the receiver and passes the question on', async () => {
    const h = await harness();
    const author = await h.signIn();
    const first = await h.signIn('First');
    const second = await h.signIn('Second');
    await online(h, first.user.id);
    const asked = (await say(h, author.cookies, 'Skip me please')).json();

    const response = await post(h, '/api/assignment/skip', undefined, first.cookies);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ questionId: asked.questionId });
    expect((await state(h, first.cookies)).assignment).toBeNull();
    // Nobody else is available yet, so the question waits ...
    expect((await state(h, author.cookies)).pendingQuestion.status).toBe('queued');
    // ... and goes to the next user who comes online, never back to the one who skipped
    await online(h, first.user.id);
    expect((await state(h, first.cookies)).assignment).toBeNull();
    await online(h, second.user.id);
    expect((await state(h, second.cookies)).assignment).toMatchObject({ text: 'Skip me please' });
  });

  it('is refused when nothing is assigned', async () => {
    const h = await harness();
    const { cookies } = await h.signIn();
    const response = await post(h, '/api/assignment/skip', undefined, cookies);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'no_active_assignment' });
  });
});

describe('POST /api/reports', () => {
  it('about a question: ends the assignment and blocks the author for this receiver', async () => {
    const h = await harness();
    const author = await h.signIn();
    const receiver = await h.signIn();
    await online(h, receiver.user.id);
    await say(h, author.cookies, 'Rude question');

    const response = await post(h, '/api/reports', { target: 'question' }, receiver.cookies);
    expect(response.statusCode).toBe(200);
    expect((await state(h, receiver.cookies)).assignment).toBeNull();
    // A new question of the same author does not reach the reporter any more
    await testDb.pool.query(`UPDATE questions SET status = 'expired' WHERE author_id = $1`, [
      author.user.id,
    ]);
    await say(h, author.cookies, 'Another question');
    expect((await state(h, receiver.cookies)).assignment).toBeNull();
    expect((await state(h, author.cookies)).pendingQuestion.status).toBe('queued');
  });

  it('about a question: is refused when nothing is assigned', async () => {
    const h = await harness();
    const { cookies } = await h.signIn();
    const response = await post(h, '/api/reports', { target: 'question' }, cookies);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'no_active_assignment' });
  });

  it('about an answer: blocks the responder for this author', async () => {
    const h = await harness();
    const author = await h.signIn();
    const responder = await h.signIn();
    await online(h, responder.user.id);
    const asked = (await say(h, author.cookies, 'Question')).json();
    await say(h, responder.cookies, 'Rude answer');

    const response = await post(
      h,
      '/api/reports',
      { target: 'answer', questionId: asked.questionId },
      author.cookies,
    );
    expect(response.statusCode).toBe(200);
    const { rows } = await testDb.pool.query(`SELECT author_id, receiver_id FROM blocks`);
    expect(rows).toEqual([{ author_id: author.user.id, receiver_id: responder.user.id }]);
  });

  it('about an answer: is refused for a question without an answer', async () => {
    const h = await harness();
    const { cookies } = await h.signIn();
    const asked = (await say(h, cookies, 'Question')).json();
    const response = await post(
      h,
      '/api/reports',
      { target: 'answer', questionId: asked.questionId },
      cookies,
    );
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'not_answered' });
  });

  it("about an answer: someone else's question is not found", async () => {
    const h = await harness();
    const author = await h.signIn();
    const stranger = await h.signIn();
    const asked = (await say(h, author.cookies, 'Question')).json();
    const response = await post(
      h,
      '/api/reports',
      { target: 'answer', questionId: asked.questionId },
      stranger.cookies,
    );
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found' });
  });

  it.each([
    [undefined],
    [{}],
    [{ target: 'nobody' }],
    [{ target: 'answer' }],
    [{ target: 'answer', questionId: 'not-a-uuid' }],
  ])('refuses the body %j', async (payload) => {
    const h = await harness();
    const { cookies } = await h.signIn();
    const response = await post(h, '/api/reports', payload ?? {}, cookies);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_request' });
  });
});
