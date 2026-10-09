import { assignments, questions } from '@human-msg/db';
import { DEFAULT_SETTINGS } from '@human-msg/shared';
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

const URL = '/admin/api/settings';
const HOUR = 3600;

describe('GET /admin/api/settings', () => {
  it('needs the back office session', async () => {
    const response = await h.app.inject({ method: 'GET', url: URL });
    expect(response.statusCode).toBe(401);
  });

  it('returns the defaults at first, with the defaults to compare', async () => {
    const body = (await h.get(URL)).json();
    expect(body.settings).toEqual(DEFAULT_SETTINGS);
    expect(body.defaults).toEqual(DEFAULT_SETTINGS);
    expect(body.settings.QUESTION_TTL).toBe(3 * HOUR);
  });
});

describe('PUT /admin/api/settings', () => {
  it('changes only the keys sent and returns the result', async () => {
    const response = await h.send('PUT', URL, { ANSWER_TIMEOUT: 600, QUIET_HOURS: '22:00-08:00' });
    expect(response.statusCode).toBe(200);
    expect(response.json().settings).toEqual({
      ...DEFAULT_SETTINGS,
      ANSWER_TIMEOUT: 600,
      QUIET_HOURS: '22:00-08:00',
    });
    expect(response.json().defaults).toEqual(DEFAULT_SETTINGS);

    // A later change keeps the earlier one
    await h.send('PUT', URL, { QUESTIONS_PER_DAY: 3 });
    expect((await h.get(URL)).json().settings).toMatchObject({
      ANSWER_TIMEOUT: 600,
      QUESTIONS_PER_DAY: 3,
    });
  });

  it('refuses invalid values with the reasons, and changes nothing', async () => {
    const cases: Array<[object, RegExp]> = [
      [{ ANSWER_TIMEOUT: -5 }, /ANSWER_TIMEOUT/],
      [{ ANSWER_TIMEOUT: 'soon' }, /ANSWER_TIMEOUT/],
      [{ QUIET_HOURS: '25:00-99:00' }, /QUIET_HOURS/],
      [{ QUIET_HOURS_TZ: 'Mars/Base' }, /QUIET_HOURS_TZ/],
      [{ MESSAGE_MAX_LENGTH: 100_000 }, /MESSAGE_MAX_LENGTH/],
      // The reminder must come before the deadline
      [{ ANSWER_REMINDER: 2 * HOUR }, /ANSWER_REMINDER/],
    ];
    for (const [payload, issue] of cases) {
      const response = await h.send('PUT', URL, payload);
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.json()).toMatchObject({ error: 'invalid' });
      expect(response.json().issues.join(' ')).toMatch(issue);
    }
    expect((await h.get(URL)).json().settings).toEqual(DEFAULT_SETTINGS);
  });

  it('refuses an unknown key, an empty body and a non-object', async () => {
    const unknown = await h.send('PUT', URL, { COFFEE_BREAK: 5 });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toBe('unknown_key');
    expect((await h.send('PUT', URL, {})).statusCode).toBe(400);
    expect((await h.send('PUT', URL, [1] as unknown as object)).statusCode).toBe(400);
  });

  it('applies to new questions and assignments, not to the ones already made', async () => {
    const author = await h.createUser();
    const receiver = await h.createUser();
    const oldQuestion = await h.core.run(async (ctx) => {
      const { askQuestion } = await import('@human-msg/core');
      return askQuestion(ctx, author.id, 'Asked before the change');
    });
    if (!oldQuestion.ok) throw new Error(oldQuestion.reason);

    const before = (await testDb.db.select().from(assignments))[0]!;
    const oldExpires = (await testDb.db.select().from(questions))[0]!.expiresAt;
    expect(before.receiverId).toBe(receiver.id);

    // The change takes effect without waiting for the settings cache
    expect(
      (
        await h.send('PUT', URL, {
          QUESTION_TTL: 1 * HOUR,
          ANSWER_TIMEOUT: 10 * 60,
          ANSWER_REMINDER: 60,
        })
      ).statusCode,
    ).toBe(200);

    // The question and the assignment that exist keep their times
    const [oldAssignment] = await testDb.db.select().from(assignments);
    expect(oldAssignment!.deadlineAt).toEqual(before.deadlineAt);
    expect((await testDb.db.select().from(questions))[0]!.expiresAt).toEqual(oldExpires);

    // A new question and assignment use the new values
    const other = await h.createUser();
    await h.createUser();
    const asked = await h.core.run(async (ctx) => {
      const { askQuestion } = await import('@human-msg/core');
      return askQuestion(ctx, other.id, 'Asked after the change');
    });
    if (!asked.ok) throw new Error(asked.reason);
    const all = await testDb.db.select().from(questions);
    const fresh = all.find((q) => q.id === asked.value.questionId)!;
    const lifetime = (fresh.expiresAt.getTime() - fresh.createdAt.getTime()) / 1000;
    expect(Math.round(lifetime)).toBe(1 * HOUR);
    const freshAssignment = (await testDb.db.select().from(assignments)).find(
      (a) => a.questionId === fresh.id,
    )!;
    const allowed =
      (freshAssignment.deadlineAt.getTime() - freshAssignment.assignedAt.getTime()) / 1000;
    expect(Math.round(allowed)).toBe(10 * 60);
    const oldLifetime =
      (oldExpires.getTime() -
        all.find((q) => q.text.startsWith('Asked before'))!.createdAt.getTime()) /
      1000;
    expect(Math.round(oldLifetime)).toBe(3 * HOUR);
  });
});
