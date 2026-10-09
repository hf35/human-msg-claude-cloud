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
const say = (h: WebHarness, cookies: Cookies, text: string) =>
  h.app.inject({ method: 'POST', url: '/api/messages', payload: { text }, cookies });
const history = (h: WebHarness, cookies?: Cookies, query = '') =>
  h.app.inject({ method: 'GET', url: `/api/history${query}`, ...(cookies && { cookies }) });
const online = (h: WebHarness, userId: string) =>
  h.core.run((ctx) => connect(ctx, userId, 'test-server'));

describe('GET /api/history', () => {
  it('requires a session', async () => {
    const h = await harness();
    expect((await history(h)).statusCode).toBe(401);
  });

  it('is empty for a new user', async () => {
    const h = await harness();
    const { cookies } = await h.signIn();
    expect((await history(h, cookies)).json()).toEqual({ items: [], nextCursor: null });
  });

  it('shows my questions with their answers and my answers with their questions', async () => {
    const h = await harness();
    const me = await h.signIn('Green Rabbit');
    const other = await h.signIn('Blue Fox');
    await online(h, other.user.id);

    // I ask, the other answers
    await say(h, me.cookies, 'My question');
    await say(h, other.cookies, 'Their answer');
    time.advance(1000);
    // The other asks, I answer
    await online(h, me.user.id);
    await say(h, other.cookies, 'Their question');
    await say(h, me.cookies, 'My answer');

    const mine = (await history(h, me.cookies)).json();
    expect(mine.nextCursor).toBeNull();
    expect(mine.items).toHaveLength(2);
    const question = mine.items.find((i: { kind: string }) => i.kind === 'question');
    const answer = mine.items.find((i: { kind: string }) => i.kind === 'answer');
    expect(question).toMatchObject({
      text: 'My question',
      status: 'answered',
      answer: { text: 'Their answer', responderAlias: 'Blue Fox' },
    });
    expect(answer).toMatchObject({
      text: 'My answer',
      questionText: 'Their question',
      authorAlias: 'Blue Fox',
    });

    // The other user sees the mirror image, never my questions or answers on their own
    const theirs = (await history(h, other.cookies)).json();
    expect(theirs.items).toHaveLength(2);
    expect(JSON.stringify(theirs)).not.toContain(me.user.id);
  });

  it('shows a question without an answer and an expired one', async () => {
    const h = await harness();
    const { user, cookies } = await h.signIn();
    await say(h, cookies, 'Waiting question');
    await testDb.pool.query(`UPDATE questions SET status = 'expired' WHERE author_id = $1`, [
      user.id,
    ]);
    await say(h, cookies, 'Second question');
    const { items } = (await history(h, cookies)).json();
    expect(items.map((i: { text: string; status: string }) => [i.text, i.status])).toEqual([
      ['Second question', 'queued'],
      ['Waiting question', 'expired'],
    ]);
    expect(items[0].answer).toBeNull();
  });

  it('is paged newest first without gaps or repeats', async () => {
    const h = await harness();
    const me = await h.signIn();
    const other = await h.signIn();
    await online(h, other.user.id);
    // 3 questions of mine (answered) and 3 answers of mine, interleaved in time
    const texts: string[] = [];
    for (let i = 0; i < 3; i++) {
      await online(h, me.user.id);
      await say(h, me.cookies, `Mine ${i}`);
      await say(h, other.cookies, `Reply ${i}`);
      texts.push(`Mine ${i}`);
      time.advance(1000);
      await say(h, other.cookies, `Theirs ${i}`);
      await say(h, me.cookies, `Answer ${i}`);
      texts.push(`Answer ${i}`);
      time.advance(1000);
      // The other's pending question is answered now; my own answers freed me for the next round
      await testDb.pool.query(`UPDATE users SET cooldown_until = NULL`);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = `?limit=4${cursor ? `&cursor=${cursor}` : ''}`;
      const page = (await history(h, me.cookies, query)).json();
      expect(page.items.length).toBeLessThanOrEqual(4);
      seen.push(...page.items.map((i: { text: string }) => i.text));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 10);

    expect(pages).toBe(2);
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
    expect(seen).toEqual([...texts].reverse());
  });

  it('keeps pages stable when a new item appears meanwhile', async () => {
    const h = await harness();
    const { user, cookies } = await h.signIn();
    for (let i = 0; i < 3; i++) {
      await say(h, cookies, `Question ${i}`);
      await testDb.pool.query(
        `UPDATE questions SET status = 'answered', answered_at = now() WHERE author_id = $1`,
        [user.id],
      );
      time.advance(1000);
    }
    const first = (await history(h, cookies, '?limit=2')).json();
    expect(first.items.map((i: { text: string }) => i.text)).toEqual(['Question 2', 'Question 1']);
    await testDb.pool.query(
      `UPDATE questions SET status = 'answered', answered_at = now() WHERE author_id = $1`,
      [user.id],
    );
    await say(h, cookies, 'Question 3');
    const second = (await history(h, cookies, `?limit=2&cursor=${first.nextCursor}`)).json();
    expect(second.items.map((i: { text: string }) => i.text)).toEqual(['Question 0']);
    expect(second.nextCursor).toBeNull();
  });

  it.each(['?limit=0', '?limit=51', '?limit=abc', '?cursor=', '?cursor=garbage', '?cursor=MXwy'])(
    'refuses the query %s',
    async (query) => {
      const h = await harness();
      const { cookies } = await h.signIn();
      const response = await history(h, cookies, query);
      expect(response.statusCode).toBe(400);
    },
  );
});
