import { createCore, emit, ok, type Core } from '@human-msg/core';
import { users } from '@human-msg/db';
import { createTestDatabase, type TestDatabase } from '@human-msg/db/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startOutboxListener, type OutboxListener } from './listener';

let testDb: TestDatabase;
let core: Core;
let userId: string;
let listener: OutboxListener | undefined;

beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(() => testDb.close());
beforeEach(async () => {
  await testDb.reset();
  core = createCore({ db: testDb.db });
  const [user] = await testDb.db
    .insert(users)
    .values({ alias: 'Listener Test', channel: 'web', googleSub: 'listener' })
    .returning();
  userId = user!.id;
});
afterEach(async () => {
  await listener?.stop();
  listener = undefined;
});

const connectionString = () => testDb.pool.options.connectionString!;

const emitEvent = () =>
  core.run(async ({ tx }) =>
    ok(await emit(tx, userId, { type: 'question.queued', questionId: 'q' })),
  );

const eventually = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`not reached in time: ${what}`);
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Ends the backend that runs the listener's `LISTEN`, as a network failure or restart would. */
async function killListenerConnection() {
  const { rows } = await testDb.pool.query<{ terminated: boolean }>(
    `SELECT pg_terminate_backend(pid) AS terminated
       FROM pg_stat_activity
      WHERE datname = current_database() AND query ILIKE 'LISTEN%' AND pid <> pg_backend_pid()`,
  );
  return rows.length;
}

describe('startOutboxListener', () => {
  it('is notified when a transaction that wrote an event commits', async () => {
    let notified = 0;
    listener = startOutboxListener({
      connectionString: connectionString(),
      onNotify: () => notified++,
    });
    await listener.ready;
    const afterConnect = notified;

    await emitEvent();

    await eventually(() => notified > afterConnect, 'notification');
  });

  it('calls onNotify once on connecting, to pick up what was written before', async () => {
    await emitEvent();
    let notified = 0;
    listener = startOutboxListener({
      connectionString: connectionString(),
      onNotify: () => notified++,
    });
    await listener.ready;
    expect(notified).toBe(1);
  });

  it('is not notified when the transaction rolls back', async () => {
    let notified = 0;
    listener = startOutboxListener({
      connectionString: connectionString(),
      onNotify: () => notified++,
    });
    await listener.ready;
    const afterConnect = notified;

    await expect(
      core.run(async ({ tx }) => {
        await emit(tx, userId, { type: 'question.queued', questionId: 'q' });
        throw new Error('command failed');
      }),
    ).rejects.toThrow('command failed');

    await pause(200);
    expect(notified).toBe(afterConnect);
  });

  it('reconnects after the connection is lost and catches up', async () => {
    let notified = 0;
    const errors: unknown[] = [];
    listener = startOutboxListener({
      connectionString: connectionString(),
      onNotify: () => notified++,
      onError: (error) => errors.push(error),
      reconnectDelayMs: 20,
    });
    await listener.ready;
    expect(await killListenerConnection()).toBe(1);
    await eventually(() => errors.length > 0, 'error report');

    // After reconnecting, onNotify is called once for what may have been missed
    await eventually(() => notified >= 2, 'catch-up call');
    const afterReconnect = notified;

    await emitEvent();
    await eventually(() => notified > afterReconnect, 'notification after reconnect');
  });

  it('keeps retrying while the database is unreachable and stops cleanly', async () => {
    const errors: unknown[] = [];
    let notified = 0;
    const unreachable = startOutboxListener({
      connectionString: 'postgres://u:p@127.0.0.1:1/none',
      onNotify: () => notified++,
      onError: (error) => errors.push(error),
      reconnectDelayMs: 20,
    });

    await eventually(() => errors.length >= 3, 'repeated attempts');
    await unreachable.stop();
    const seen = errors.length;
    await pause(150);

    expect(errors.length).toBe(seen);
    expect(notified).toBe(0);
  });

  it('gets no notifications after stop()', async () => {
    let notified = 0;
    listener = startOutboxListener({
      connectionString: connectionString(),
      onNotify: () => notified++,
    });
    await listener.ready;
    await listener.stop();
    const afterStop = notified;

    await emitEvent();
    await pause(200);

    expect(notified).toBe(afterStop);
    // The listener's connection is closed on the server too
    const { rows } = await testDb.pool.query(
      `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND query ILIKE 'LISTEN%' AND pid <> pg_backend_pid()`,
    );
    expect(rows).toHaveLength(0);
  });
});
