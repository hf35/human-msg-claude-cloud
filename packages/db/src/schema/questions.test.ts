import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '../client';
import { runMigrations } from '../migrate';
import { answers, questions, type NewQuestion } from './questions';
import { users } from './users';

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

async function createUsers(tx: Tx) {
  const [author, responder] = await tx
    .insert(users)
    .values([
      { channel: 'web', alias: 'Author', googleSub: 'q-author' },
      { channel: 'web', alias: 'Responder', googleSub: 'q-responder' },
    ])
    .returning();
  return { author: author!, responder: responder! };
}

const question = (authorId: string, extra: Partial<NewQuestion> = {}): NewQuestion => ({
  authorId,
  text: 'How are you?',
  expiresAt: new Date(Date.now() + 3 * 3600_000),
  ...extra,
});

const errorCode = (error: unknown): unknown => (error as { cause?: { code?: string } }).cause?.code;

describe('questions table', () => {
  it('creates queued questions by default', async () => {
    let status: string | undefined;
    await inRollback(async (tx) => {
      const { author } = await createUsers(tx);
      const [created] = await tx.insert(questions).values(question(author.id)).returning();
      status = created?.status;
    });
    expect(status).toBe('queued');
  });

  it('rejects an unknown status', async () => {
    let code: unknown;
    await inRollback(async (tx) => {
      const { author } = await createUsers(tx);
      await tx
        .transaction((inner) =>
          inner.insert(questions).values(question(author.id, { status: 'bogus' as never })),
        )
        .catch((e: unknown) => (code = errorCode(e)));
    });
    expect(code).toBe('23514');
  });

  it('requires answered_at exactly for answered questions', async () => {
    const codes: unknown[] = [];
    await inRollback(async (tx) => {
      const { author } = await createUsers(tx);
      for (const extra of [
        { status: 'answered' as const },
        { status: 'queued' as const, answeredAt: new Date() },
      ]) {
        await tx
          .transaction((inner) => inner.insert(questions).values(question(author.id, extra)))
          .catch((e: unknown) => codes.push(errorCode(e)));
      }
      const [ok] = await tx
        .insert(questions)
        .values(question(author.id, { status: 'answered', answeredAt: new Date() }))
        .returning();
      expect(ok?.status).toBe('answered');
    });
    expect(codes).toEqual(['23514', '23514']);
  });

  it('requires an existing author', async () => {
    let code: unknown;
    await inRollback(async (tx) => {
      await tx
        .transaction((inner) =>
          inner.insert(questions).values(question('00000000-0000-4000-8000-000000000000')),
        )
        .catch((e: unknown) => (code = errorCode(e)));
    });
    expect(code).toBe('23503');
  });
});

describe('answers table', () => {
  it('stores an answer as a separate row linked to the question', async () => {
    let stored: { questionId: string; text: string } | undefined;
    let questionId: string | undefined;
    await inRollback(async (tx) => {
      const { author, responder } = await createUsers(tx);
      const [q] = await tx.insert(questions).values(question(author.id)).returning();
      questionId = q!.id;
      const [a] = await tx
        .insert(answers)
        .values({ questionId: q!.id, authorId: responder.id, text: 'Fine' })
        .returning();
      stored = a;
    });
    expect(stored).toMatchObject({ questionId, text: 'Fine' });
  });

  it('allows only one answer per question', async () => {
    let code: unknown;
    await inRollback(async (tx) => {
      const { author, responder } = await createUsers(tx);
      const [q] = await tx.insert(questions).values(question(author.id)).returning();
      const row = { questionId: q!.id, authorId: responder.id, text: 'Fine' };
      await tx.insert(answers).values(row);
      await tx
        .transaction((inner) => inner.insert(answers).values(row))
        .catch((e: unknown) => (code = errorCode(e)));
    });
    expect(code).toBe('23505');
  });

  it('requires an existing question', async () => {
    let code: unknown;
    await inRollback(async (tx) => {
      const { responder } = await createUsers(tx);
      await tx
        .transaction((inner) =>
          inner.insert(answers).values({
            questionId: '00000000-0000-4000-8000-000000000000',
            authorId: responder.id,
            text: 'Fine',
          }),
        )
        .catch((e: unknown) => (code = errorCode(e)));
    });
    expect(code).toBe('23503');
  });
});
