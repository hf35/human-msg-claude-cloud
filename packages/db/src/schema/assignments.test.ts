import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '../client';
import { runMigrations } from '../migrate';
import { assignments, type NewAssignment } from './assignments';
import { questions } from './questions';
import { users, type User } from './users';

const pool = createPool(
  process.env.DATABASE_URL ?? 'postgres://humanmsg:humanmsg@localhost:5432/humanmsg',
);
const db = createDb(pool);

beforeAll(() => runMigrations(db));
afterAll(() => pool.end());

class Rollback extends Error {}
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Runs the body in a transaction that is always rolled back, so no rows are left behind. */
async function inRollback(body: (tx: Tx) => Promise<void>): Promise<void> {
  await db
    .transaction(async (tx) => {
      await body(tx);
      throw new Rollback();
    })
    .catch((error: unknown) => {
      if (!(error instanceof Rollback)) throw error;
    });
}

const errorCode = (error: unknown): unknown => (error as { cause?: { code?: string } }).cause?.code;

/** Returns the Postgres error code of a failing insert (in a savepoint, so `tx` stays usable). */
async function insertErrorCode(tx: Tx, row: NewAssignment): Promise<unknown> {
  let code: unknown;
  await tx
    .transaction((inner) => inner.insert(assignments).values(row))
    .catch((e: unknown) => (code = errorCode(e)));
  return code;
}

async function fixture(tx: Tx) {
  const people = await tx
    .insert(users)
    .values(
      ['A', 'B', 'C', 'D'].map((name) => ({
        channel: 'web' as const,
        alias: `Assign ${name}`,
        googleSub: `assign-${name}`,
      })),
    )
    .returning();
  const [author1, r1, r2, author2] = people as [User, User, User, User];
  const qs = await tx
    .insert(questions)
    .values(
      // An author can have only one pending question, so each question has its own author
      [author1, author2].map((author, n) => ({
        authorId: author.id,
        text: `Question ${n + 1}`,
        expiresAt: new Date(Date.now() + 3600_000),
      })),
    )
    .returning();
  const [q1, q2] = qs as [(typeof qs)[0], (typeof qs)[0]];
  return { r1, r2, q1, q2 };
}

const deadline = () => new Date(Date.now() + 1800_000);
const ended = { outcome: 'skipped', endedAt: new Date() } as const;

describe('assignments table', () => {
  it('is active by default', async () => {
    let created: unknown;
    await inRollback(async (tx) => {
      const { r1, q1 } = await fixture(tx);
      [created] = await tx
        .insert(assignments)
        .values({ questionId: q1.id, receiverId: r1.id, deadlineAt: deadline() })
        .returning();
    });
    expect(created).toMatchObject({ outcome: null, endedAt: null, remindedAt: null });
  });

  it('gives a receiver at most one active assignment (rule 3)', async () => {
    let code: unknown;
    await inRollback(async (tx) => {
      const { r1, q1, q2 } = await fixture(tx);
      await tx
        .insert(assignments)
        .values({ questionId: q1.id, receiverId: r1.id, deadlineAt: deadline() });
      code = await insertErrorCode(tx, {
        questionId: q2.id,
        receiverId: r1.id,
        deadlineAt: deadline(),
      });
    });
    expect(code).toBe('23505');
  });

  it('gives a question at most one active assignment', async () => {
    let code: unknown;
    await inRollback(async (tx) => {
      const { r1, r2, q1 } = await fixture(tx);
      await tx
        .insert(assignments)
        .values({ questionId: q1.id, receiverId: r1.id, deadlineAt: deadline() });
      code = await insertErrorCode(tx, {
        questionId: q1.id,
        receiverId: r2.id,
        deadlineAt: deadline(),
      });
    });
    expect(code).toBe('23505');
  });

  it('frees the receiver and the question once the assignment ends', async () => {
    let second: unknown;
    await inRollback(async (tx) => {
      const { r1, r2, q1, q2 } = await fixture(tx);
      await tx
        .insert(assignments)
        .values({ questionId: q1.id, receiverId: r1.id, deadlineAt: deadline(), ...ended });
      // The same receiver can take another question, another receiver can take the same one
      [second] = await tx
        .insert(assignments)
        .values([
          { questionId: q2.id, receiverId: r1.id, deadlineAt: deadline() },
          { questionId: q1.id, receiverId: r2.id, deadlineAt: deadline() },
        ])
        .returning();
    });
    expect(second).toBeDefined();
  });

  it('never assigns the same question to the same receiver twice (rule 6)', async () => {
    let code: unknown;
    await inRollback(async (tx) => {
      const { r1, q1 } = await fixture(tx);
      await tx
        .insert(assignments)
        .values({ questionId: q1.id, receiverId: r1.id, deadlineAt: deadline(), ...ended });
      code = await insertErrorCode(tx, {
        questionId: q1.id,
        receiverId: r1.id,
        deadlineAt: deadline(),
      });
    });
    expect(code).toBe('23505');
  });

  it('rejects an unknown outcome and an outcome without an end time', async () => {
    const codes: unknown[] = [];
    await inRollback(async (tx) => {
      const { r1, q1 } = await fixture(tx);
      const base = { questionId: q1.id, receiverId: r1.id, deadlineAt: deadline() };
      codes.push(
        await insertErrorCode(tx, { ...base, outcome: 'bogus' as never, endedAt: new Date() }),
        await insertErrorCode(tx, { ...base, outcome: 'answered' }),
        await insertErrorCode(tx, { ...base, endedAt: new Date() }),
      );
    });
    expect(codes).toEqual(['23514', '23514', '23514']);
  });

  it('rejects a deadline that is not after the assignment time', async () => {
    let code: unknown;
    await inRollback(async (tx) => {
      const { r1, q1 } = await fixture(tx);
      const at = new Date();
      code = await insertErrorCode(tx, {
        questionId: q1.id,
        receiverId: r1.id,
        assignedAt: at,
        deadlineAt: at,
      });
    });
    expect(code).toBe('23514');
  });

  it('requires an existing question and receiver', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    const codes: unknown[] = [];
    await inRollback(async (tx) => {
      const { r1, q1 } = await fixture(tx);
      codes.push(
        await insertErrorCode(tx, {
          questionId: missing,
          receiverId: r1.id,
          deadlineAt: deadline(),
        }),
        await insertErrorCode(tx, {
          questionId: q1.id,
          receiverId: missing,
          deadlineAt: deadline(),
        }),
      );
    });
    expect(codes).toEqual(['23503', '23503']);
  });
});
