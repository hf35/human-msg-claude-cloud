import { outbox, users } from '@human-msg/db';
import { createTestDatabase, type TestDatabase } from '@human-msg/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createCore } from './core';
import { emit, OUTBOX_CHANNEL } from './outbox';
import { ok } from './result';

let testDb: TestDatabase;
let userId: string;

beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(() => testDb.close());
beforeEach(async () => {
  await testDb.reset();
  const [user] = await testDb.db
    .insert(users)
    .values({ channel: 'web', alias: 'Outbox Test', googleSub: 'outbox' })
    .returning();
  userId = user!.id;
});

const core = () => createCore({ db: testDb.db });
const committedEvents = () => testDb.db.select().from(outbox);

/** Collects notifications of the outbox channel on a separate connection. */
async function listen() {
  const client = new pg.Client({ connectionString: testDb.pool.options.connectionString });
  await client.connect();
  await client.query(`LISTEN ${OUTBOX_CHANNEL}`);
  const received: string[] = [];
  client.on('notification', (message) => received.push(message.payload ?? ''));
  return {
    received,
    // A notification sent by a committed transaction arrives shortly after the commit
    settle: () => new Promise((resolve) => setTimeout(resolve, 200)),
    close: () => client.end(),
  };
}

describe('emit', () => {
  it('writes the event with type and payload, undelivered', async () => {
    const result = await core().run(async ({ tx }) =>
      ok(await emit(tx, userId, { type: 'question.queued', questionId: 'q-1' })),
    );
    const rows = await committedEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: result.ok ? result.value : -1,
      userId,
      type: 'question.queued',
      payload: { questionId: 'q-1' },
      attempts: 0,
      deliveredAt: null,
    });
  });

  it('shows the event only after the transaction commits', async () => {
    await core().run(async ({ tx }) => {
      await emit(tx, userId, { type: 'question.expired', questionId: 'q-2' });
      expect(await committedEvents()).toHaveLength(0);
      return ok();
    });
    expect(await committedEvents()).toHaveLength(1);
  });

  it('leaves nothing behind when the transaction rolls back', async () => {
    await expect(
      core().run(async ({ tx }) => {
        await emit(tx, userId, { type: 'question.queued', questionId: 'q-3' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await committedEvents()).toHaveLength(0);
  });

  it('refuses an invalid event and writes nothing', async () => {
    const bad = { type: 'message.rejected', reason: 'nope' } as never;
    await expect(
      core().run(async ({ tx }) => (await emit(tx, userId, bad), ok())),
    ).rejects.toThrow();
    expect(await committedEvents()).toHaveLength(0);
  });

  it('wakes the dispatcher on commit only', async () => {
    const listener = await listen();
    try {
      await expect(
        core().run(async ({ tx }) => {
          await emit(tx, userId, { type: 'question.queued', questionId: 'rolled-back' });
          throw new Error('boom');
        }),
      ).rejects.toThrow();
      await listener.settle();
      expect(listener.received).toEqual([]);

      const result = await core().run(async ({ tx }) =>
        ok(await emit(tx, userId, { type: 'question.queued', questionId: 'committed' })),
      );
      await listener.settle();
      expect(listener.received).toEqual([String(result.ok ? result.value : '')]);
    } finally {
      await listener.close();
    }
  });
});
