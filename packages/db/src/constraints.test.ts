import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { answers, assignments, questions, users } from './schema';
import { createTestDatabase, type TestDatabase } from './testing';

/**
 * The database itself must reject what the rules forbid, so that races between parallel
 * requests cannot break them. Rows here are committed, no transaction tricks.
 */
let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(() => testDb.close());
beforeEach(() => testDb.reset());

const deadlineAt = () => new Date(Date.now() + 30 * 60_000);
const expiresAt = () => new Date(Date.now() + 3 * 3600_000);

async function createUsers(count: number) {
  const rows = await testDb.db
    .insert(users)
    .values(
      Array.from({ length: count }, (_, i) => ({
        channel: 'web' as const,
        alias: `User ${i}`,
        googleSub: `sub-${i}`,
      })),
    )
    .returning();
  return rows.sort((a, b) => a.alias.localeCompare(b.alias));
}

async function createQuestion(authorId: string) {
  const [question] = await testDb.db
    .insert(questions)
    .values({ authorId, text: 'Question', expiresAt: expiresAt() })
    .returning();
  return question!;
}

/** Postgres error code of a rejected promise, or `undefined` if it succeeded. */
async function codeOf(promise: PromiseLike<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { cause?: { code?: string } }).cause?.code;
  }
}

const UNIQUE_VIOLATION = '23505';

describe('database constraints', () => {
  it('rejects two active assignments for one receiver (rule 3)', async () => {
    const [a, b, receiver] = await createUsers(3);
    const q1 = await createQuestion(a!.id);
    const q2 = await createQuestion(b!.id);
    await testDb.db
      .insert(assignments)
      .values({ questionId: q1.id, receiverId: receiver!.id, deadlineAt: deadlineAt() });
    const code = await codeOf(
      testDb.db
        .insert(assignments)
        .values({ questionId: q2.id, receiverId: receiver!.id, deadlineAt: deadlineAt() }),
    );
    expect(code).toBe(UNIQUE_VIOLATION);
  });

  it('rejects two active assignments for one question', async () => {
    const [author, r1, r2] = await createUsers(3);
    const q = await createQuestion(author!.id);
    await testDb.db
      .insert(assignments)
      .values({ questionId: q.id, receiverId: r1!.id, deadlineAt: deadlineAt() });
    const code = await codeOf(
      testDb.db
        .insert(assignments)
        .values({ questionId: q.id, receiverId: r2!.id, deadlineAt: deadlineAt() }),
    );
    expect(code).toBe(UNIQUE_VIOLATION);
  });

  it('rejects assigning the same pair twice (rule 6)', async () => {
    const [author, receiver] = await createUsers(2);
    const q = await createQuestion(author!.id);
    await testDb.db.insert(assignments).values({
      questionId: q.id,
      receiverId: receiver!.id,
      deadlineAt: deadlineAt(),
      outcome: 'timed_out',
      endedAt: new Date(),
    });
    const code = await codeOf(
      testDb.db
        .insert(assignments)
        .values({ questionId: q.id, receiverId: receiver!.id, deadlineAt: deadlineAt() }),
    );
    expect(code).toBe(UNIQUE_VIOLATION);
  });

  it('rejects two pending questions of one author (rule 2)', async () => {
    const [author] = await createUsers(1);
    await createQuestion(author!.id);
    const code = await codeOf(createQuestion(author!.id));
    expect(code).toBe(UNIQUE_VIOLATION);
  });

  it('rejects two answers to one question (rule 4)', async () => {
    const [author, responder] = await createUsers(2);
    const q = await createQuestion(author!.id);
    const answer = { questionId: q.id, authorId: responder!.id, text: 'Answer' };
    await testDb.db.insert(answers).values(answer);
    expect(await codeOf(testDb.db.insert(answers).values(answer))).toBe(UNIQUE_VIOLATION);
  });
});

describe('database constraints under parallel requests', () => {
  /** Runs the inserts at the same time, each on its own connection. */
  const inParallel = (jobs: PromiseLike<unknown>[]) => Promise.all(jobs.map(codeOf));

  it('lets exactly one of several concurrent assignments reach a receiver (rule 3)', async () => {
    const authors = await createUsers(6);
    const receiver = authors.pop()!;
    const qs = await Promise.all(authors.map((author) => createQuestion(author.id)));
    const codes = await inParallel(
      qs.map((q) =>
        testDb.db
          .insert(assignments)
          .values({ questionId: q.id, receiverId: receiver.id, deadlineAt: deadlineAt() }),
      ),
    );
    expect(codes.filter((code) => code === undefined)).toHaveLength(1);
    expect(codes.filter((code) => code === UNIQUE_VIOLATION)).toHaveLength(qs.length - 1);
    expect(await testDb.db.select().from(assignments)).toHaveLength(1);
  });

  it('lets exactly one of several concurrent receivers take a question', async () => {
    const [author, ...receivers] = await createUsers(6);
    const q = await createQuestion(author!.id);
    const codes = await inParallel(
      receivers.map((receiver) =>
        testDb.db
          .insert(assignments)
          .values({ questionId: q.id, receiverId: receiver.id, deadlineAt: deadlineAt() }),
      ),
    );
    expect(codes.filter((code) => code === undefined)).toHaveLength(1);
    expect(await testDb.db.select().from(assignments)).toHaveLength(1);
  });

  it('lets exactly one of several concurrent questions of an author in (rule 2)', async () => {
    const [author] = await createUsers(1);
    const codes = await inParallel(Array.from({ length: 5 }, () => createQuestion(author!.id)));
    expect(codes.filter((code) => code === undefined)).toHaveLength(1);
    expect(await testDb.db.select().from(questions)).toHaveLength(1);
  });

  it('lets exactly one of several concurrent answers in (rule 4)', async () => {
    const [author, ...responders] = await createUsers(5);
    const q = await createQuestion(author!.id);
    const codes = await inParallel(
      responders.map((responder) =>
        testDb.db.insert(answers).values({ questionId: q.id, authorId: responder.id, text: 'A' }),
      ),
    );
    expect(codes.filter((code) => code === undefined)).toHaveLength(1);
    expect(await testDb.db.select().from(answers)).toHaveLength(1);
  });
});
