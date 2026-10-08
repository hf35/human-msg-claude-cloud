import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '../client';
import { runMigrations } from '../migrate';
import { users, type NewUser, type User } from './users';

const pool = createPool(
  process.env.DATABASE_URL ?? 'postgres://humanmsg:humanmsg@localhost:5432/humanmsg',
);
const db = createDb(pool);

beforeAll(() => runMigrations(db));
afterAll(() => pool.end());

class Rollback extends Error {}

/** Runs the inserts in a transaction that is always rolled back, so no rows are left behind. */
async function insertAndRollback(...rows: NewUser[]): Promise<void> {
  await db
    .transaction(async (tx) => {
      for (const row of rows) await tx.insert(users).values(row);
      throw new Rollback();
    })
    .catch((error: unknown) => {
      if (!(error instanceof Rollback)) throw error;
    });
}

const web = (alias: string, extra: Partial<NewUser> = {}): NewUser => ({
  channel: 'web',
  alias,
  ...extra,
});

describe('users table', () => {
  it('fills in the defaults', async () => {
    let created: User | undefined;
    await db
      .transaction(async (tx) => {
        [created] = await tx
          .insert(users)
          .values(web('Green Rabbit', { googleSub: 'g1' }))
          .returning();
        throw new Rollback();
      })
      .catch((error: unknown) => {
        if (!(error instanceof Rollback)) throw error;
      });
    expect(created).toMatchObject({
      locale: 'ru',
      isTest: false,
      isStaff: false,
      receivingEnabled: true,
      botBlockedAt: null,
      cooldownUntil: null,
    });
    expect(created?.createdAt).toBeInstanceOf(Date);
  });

  it.each([
    ['alias', [web('Green Rabbit'), { channel: 'telegram', alias: 'Green Rabbit' } as NewUser]],
    ['google_sub', [web('A', { googleSub: 'same' }), web('B', { googleSub: 'same' })]],
    [
      'telegram_id',
      [
        { channel: 'telegram', alias: 'A', telegramId: 42 },
        { channel: 'telegram', alias: 'B', telegramId: 42 },
      ] as NewUser[],
    ],
  ])('rejects a duplicate %s', async (_column, rows) => {
    await expect(insertAndRollback(...rows)).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('allows many users without an identity', async () => {
    await insertAndRollback(web('A'), web('B'), web('C', { isTest: true }));
  });

  it('keeps Telegram ids above 32 bits', async () => {
    await insertAndRollback({ channel: 'telegram', alias: 'A', telegramId: 7_000_000_000 });
  });

  it.each([
    ['an unknown channel', { channel: 'sms', alias: 'A' }],
    ['an unknown locale', { channel: 'web', alias: 'A', locale: 'de' }],
    ['a web user with a Telegram id', { channel: 'web', alias: 'A', telegramId: 1 }],
    ['a Telegram user with a Google id', { channel: 'telegram', alias: 'A', googleSub: 'g' }],
  ])('rejects %s', async (_name, row) => {
    await expect(insertAndRollback(row as NewUser)).rejects.toMatchObject({
      cause: { code: '23514' },
    });
  });

  it('is created by the migration', async () => {
    const result = await db.execute(sql`select to_regclass('public.users') as name`);
    expect(result.rows[0]).toEqual({ name: 'users' });
  });
});
