import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '../client';
import { runMigrations } from '../migrate';
import { blocks } from './blocks';
import { outbox } from './outbox';
import { questions } from './questions';
import { sessions } from './sessions';
import { settings } from './settings';
import { users, type User } from './users';
import { webConnections } from './web-connections';

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

/** Returns the Postgres error code of a failing statement (in a savepoint, so `tx` stays usable). */
async function errorCode(tx: Tx, statement: (inner: Tx) => Promise<unknown>): Promise<unknown> {
  let code: unknown;
  await tx
    .transaction((inner) => statement(inner))
    .catch((e: unknown) => (code = (e as { cause?: { code?: string } }).cause?.code));
  return code;
}

async function twoUsers(tx: Tx) {
  const rows = await tx
    .insert(users)
    .values(
      ['X', 'Y', 'Z'].map((n) => ({
        channel: 'web' as const,
        alias: `Svc ${n}`,
        googleSub: `svc-${n}`,
      })),
    )
    .returning();
  return rows as [User, User, User];
}

const expiresAt = () => new Date(Date.now() + 3600_000);

describe('one pending question per author (rule 2)', () => {
  it('rejects a second queued or assigned question and allows it after the first ends', async () => {
    const codes: unknown[] = [];
    await inRollback(async (tx) => {
      const [author] = await twoUsers(tx);
      const base = { authorId: author.id, text: 'Question', expiresAt: expiresAt() };
      const [first] = await tx.insert(questions).values(base).returning();
      codes.push(await errorCode(tx, (t) => t.insert(questions).values(base)));
      await tx
        .update(questions)
        .set({ status: 'assigned' })
        .where(sql`id = ${first!.id}`);
      codes.push(await errorCode(tx, (t) => t.insert(questions).values(base)));
      await tx
        .update(questions)
        .set({ status: 'expired' })
        .where(sql`id = ${first!.id}`);
      codes.push(await errorCode(tx, (t) => t.insert(questions).values(base)));
    });
    expect(codes).toEqual(['23505', '23505', undefined]);
  });

  it('does not limit different authors', async () => {
    await inRollback(async (tx) => {
      const [a, b] = await twoUsers(tx);
      await tx.insert(questions).values([
        { authorId: a.id, text: 'One', expiresAt: expiresAt() },
        { authorId: b.id, text: 'Two', expiresAt: expiresAt() },
      ]);
    });
  });
});

describe('blocks table', () => {
  it('accepts either party as the reporter and keeps one row per direction', async () => {
    const codes: unknown[] = [];
    await inRollback(async (tx) => {
      const [author, receiver, other] = await twoUsers(tx);
      const [q] = await tx
        .insert(questions)
        .values({ authorId: author.id, text: 'Question', expiresAt: expiresAt() })
        .returning();
      const base = { authorId: author.id, receiverId: receiver.id, questionId: q!.id };
      await tx.insert(blocks).values({ ...base, reportedBy: receiver.id });
      codes.push(
        // the same direction twice
        await errorCode(tx, (t) => t.insert(blocks).values({ ...base, reportedBy: author.id })),
        // the opposite direction is a separate exclusion
        await errorCode(tx, (t) =>
          t.insert(blocks).values({
            authorId: receiver.id,
            receiverId: author.id,
            reportedBy: author.id,
            questionId: q!.id,
          }),
        ),
        // a third person cannot complain
        await errorCode(tx, (t) =>
          t.insert(blocks).values({
            authorId: author.id,
            receiverId: other.id,
            reportedBy: receiver.id,
            questionId: q!.id,
          }),
        ),
        // nobody blocks themselves
        await errorCode(tx, (t) =>
          t.insert(blocks).values({
            authorId: author.id,
            receiverId: author.id,
            reportedBy: author.id,
            questionId: q!.id,
          }),
        ),
      );
    });
    expect(codes).toEqual(['23505', undefined, '23514', '23514']);
  });
});

describe('settings table', () => {
  it('stores a value per key and rejects duplicates and nulls', async () => {
    const codes: unknown[] = [];
    await inRollback(async (tx) => {
      const [row] = await tx.insert(settings).values({ key: 'TEST_KEY', value: 1800 }).returning();
      expect(row).toMatchObject({ key: 'TEST_KEY', value: 1800 });
      expect(row?.updatedAt).toBeInstanceOf(Date);
      codes.push(
        await errorCode(tx, (t) => t.insert(settings).values({ key: 'TEST_KEY', value: 1 })),
        await errorCode(tx, (t) =>
          t.insert(settings).values({ key: 'OTHER', value: null as never }),
        ),
      );
    });
    expect(codes).toEqual(['23505', '23502']);
  });
});

describe('web_connections table', () => {
  it('allows several connections per user and requires an existing user', async () => {
    let code: unknown;
    let count = 0;
    await inRollback(async (tx) => {
      const [user] = await twoUsers(tx);
      const rows = await tx
        .insert(webConnections)
        .values([
          { userId: user.id, serverId: 'srv-1' },
          { userId: user.id, serverId: 'srv-1' },
        ])
        .returning();
      count = rows.length;
      code = await errorCode(tx, (t) =>
        t
          .insert(webConnections)
          .values({ userId: '00000000-0000-4000-8000-000000000000', serverId: 'srv-1' }),
      );
    });
    expect(count).toBe(2);
    expect(code).toBe('23503');
  });
});

describe('sessions table', () => {
  it('belongs either to a user or to the admin', async () => {
    const codes: unknown[] = [];
    await inRollback(async (tx) => {
      const [user] = await twoUsers(tx);
      const base = { expiresAt: expiresAt() };
      codes.push(
        await errorCode(tx, (t) =>
          t.insert(sessions).values({ ...base, id: 'hash-user', userId: user.id }),
        ),
        await errorCode(tx, (t) =>
          t.insert(sessions).values({ ...base, id: 'hash-admin', isAdmin: true }),
        ),
        // neither
        await errorCode(tx, (t) => t.insert(sessions).values({ ...base, id: 'hash-none' })),
        // both
        await errorCode(tx, (t) =>
          t.insert(sessions).values({ ...base, id: 'hash-both', userId: user.id, isAdmin: true }),
        ),
      );
    });
    expect(codes).toEqual([undefined, undefined, '23514', '23514']);
  });
});

describe('outbox table', () => {
  it('queues events as undelivered with ordered ids', async () => {
    let rows: (typeof outbox.$inferSelect)[] = [];
    await inRollback(async (tx) => {
      const [user] = await twoUsers(tx);
      rows = await tx
        .insert(outbox)
        .values([
          { userId: user.id, type: 'question_assigned', payload: { questionId: 'q1' } },
          { userId: user.id, type: 'answer_received', payload: {} },
        ])
        .returning();
    });
    expect(rows[1]!.id).toBeGreaterThan(rows[0]!.id);
    expect(rows[0]).toMatchObject({
      payload: { questionId: 'q1' },
      attempts: 0,
      deliveredAt: null,
      lastError: null,
    });
    expect(rows[0]!.nextAttemptAt).toBeInstanceOf(Date);
  });
});
