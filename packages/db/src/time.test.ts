import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assignments, questions, users } from './schema';
import { createTestDatabase, type TestDatabase } from './testing';
import { createManualTime, systemTime } from './time';

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(() => testDb.close());
beforeEach(() => testDb.reset());

const MINUTE = 60_000;

async function databaseTime(time: { now(): ReturnType<typeof systemTime.now> }): Promise<Date> {
  const result = await testDb.db.execute<{ t: Date }>(sql`SELECT ${time.now()} AS t`);
  return new Date(result.rows[0]!.t);
}

describe('time source', () => {
  it('the system source is the database clock', async () => {
    const before = Date.now();
    const t = await databaseTime(systemTime);
    expect(Math.abs(t.getTime() - before)).toBeLessThan(5_000);
  });

  it('moves the clock by 31 minutes and SQL sees it', async () => {
    const time = createManualTime();
    const before = await databaseTime(time);
    time.advance(31 * MINUTE);
    const after = await databaseTime(time);
    expect(Math.round((after.getTime() - before.getTime()) / MINUTE)).toBe(31);

    time.reset();
    const reset = await databaseTime(time);
    expect(Math.abs(reset.getTime() - before.getTime())).toBeLessThan(5_000);
  });

  it('makes a 30-minute deadline overdue only after the shift', async () => {
    const time = createManualTime();
    const { db } = testDb;
    const [author, receiver] = await db
      .insert(users)
      .values([
        { channel: 'web', alias: 'Author', googleSub: 'a' },
        { channel: 'web', alias: 'Receiver', googleSub: 'r' },
      ])
      .returning();
    const [question] = await db
      .insert(questions)
      .values({
        authorId: author!.id,
        text: 'Question',
        expiresAt: sql`${time.now()} + interval '3 hours'`,
      })
      .returning();
    await db.insert(assignments).values({
      questionId: question!.id,
      receiverId: receiver!.id,
      deadlineAt: sql`${time.now()} + interval '30 minutes'`,
    });

    const overdue = async () =>
      (
        await db
          .select({ id: assignments.id })
          .from(assignments)
          .where(sql`${assignments.outcome} IS NULL AND ${assignments.deadlineAt} <= ${time.now()}`)
      ).length;

    expect(await overdue()).toBe(0);
    time.advance(31 * MINUTE);
    expect(await overdue()).toBe(1);
  });
});
