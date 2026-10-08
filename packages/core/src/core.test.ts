import { users } from '@human-msg/db';
import { createManualTime } from '@human-msg/db';
import { createTestDatabase, type TestDatabase } from '@human-msg/db/testing';
import { DEFAULT_SETTINGS } from '@human-msg/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCore, fail, ok, staticSettings } from './index';

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(() => testDb.close());
beforeEach(() => testDb.reset());

/** Counts users through another connection, i.e. only what has been committed. */
async function committedUsers(): Promise<number> {
  const { rows } = await testDb.pool.query<{ n: string }>('SELECT count(*) AS n FROM users');
  return Number(rows[0]!.n);
}

const newUser = { channel: 'web', alias: 'Core Test', googleSub: 'core' } as const;

describe('core.run', () => {
  it('runs an empty command and returns its value', async () => {
    const core = createCore({ db: testDb.db });
    const result = await core.run(async () => ok(42));
    expect(result).toEqual({ ok: true, value: 42 });
  });

  it('runs the command inside one transaction and commits it', async () => {
    const core = createCore({ db: testDb.db });
    const result = await core.run(async ({ tx }) => {
      await tx.insert(users).values(newUser);
      // The write is visible to the command itself, but not yet to other connections
      expect(await tx.select().from(users)).toHaveLength(1);
      expect(await committedUsers()).toBe(0);
      return ok();
    });
    expect(result.ok).toBe(true);
    expect(await committedUsers()).toBe(1);
  });

  it('rolls back and rethrows when the command throws', async () => {
    const core = createCore({ db: testDb.db });
    await expect(
      core.run(async ({ tx }) => {
        await tx.insert(users).values(newUser);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await committedUsers()).toBe(0);
  });

  it('commits what a command wrote even when it refuses', async () => {
    const core = createCore({ db: testDb.db });
    const result = await core.run(async ({ tx }) => {
      await tx.insert(users).values(newUser);
      return fail('not_allowed');
    });
    expect(result).toEqual({ ok: false, reason: 'not_allowed' });
    expect(await committedUsers()).toBe(1);
  });

  it('gives the command the clock and a settings snapshot', async () => {
    const time = createManualTime();
    const settings = { ...DEFAULT_SETTINGS, ANSWER_TIMEOUT: 60 };
    const core = createCore({ db: testDb.db, time, settings: staticSettings(settings) });
    const result = await core.run(async (ctx) =>
      ok({ time: ctx.time === time, timeout: ctx.settings.ANSWER_TIMEOUT }),
    );
    expect(result).toEqual({ ok: true, value: { time: true, timeout: 60 } });
  });

  it('reads the settings once per command', async () => {
    let reads = 0;
    const core = createCore({
      db: testDb.db,
      settings: {
        get: async () => {
          reads++;
          return DEFAULT_SETTINGS;
        },
      },
    });
    await core.run(async () => ok());
    expect(reads).toBe(1);
  });
});
