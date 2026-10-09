import { askQuestion, emit, ok } from '@human-msg/core';
import { createManualTime, users, webConnections, type NewUser } from '@human-msg/db';
import { createTestDatabase, type TestDatabase } from '@human-msg/db/testing';
import net from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from './config';
import type { OutboxDelivery } from '@human-msg/core';
import { startServer, type RunningServer, type StartServerOptions } from './server';

let testDb: TestDatabase;
const time = createManualTime();
let running: RunningServer | undefined;

beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(() => testDb.close());
beforeEach(async () => {
  time.reset();
  await testDb.reset();
});
afterEach(async () => {
  await running?.stop();
  running = undefined;
});

const config = (env: Record<string, string> = {}): Config =>
  loadConfig({
    DATABASE_URL: testDb.pool.options.connectionString!,
    LOG_LEVEL: 'silent',
    PORT: '0',
    // The timers are slow on purpose, so tests show what wakes the modules up
    WORKER_INTERVAL: '60',
    DISPATCH_INTERVAL: '60',
    ...env,
  });

const start = async (env: Record<string, string> = {}, options: StartServerOptions = {}) =>
  (running = await startServer(config(env), { listenerReconnectMs: 20, ...options }));

let counter = 0;
async function createUser(values: Partial<NewUser> = {}) {
  counter++;
  const [user] = await testDb.db
    .insert(users)
    .values({
      alias: `Server ${counter}`,
      channel: 'telegram',
      telegramId: 9000 + counter,
      ...values,
    })
    .returning();
  return user!;
}

const eventually = async (check: () => Promise<boolean> | boolean, what: string) => {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`not reached in time: ${what}`);
};

/** Backends that run a `LISTEN`, i.e. open listeners of the outbox. */
const listenerConnections = async () =>
  (
    await testDb.pool.query(
      `SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND query ILIKE 'LISTEN%' AND pid <> pg_backend_pid()`,
    )
  ).rowCount ?? 0;

describe('startServer', () => {
  it('starts against the database and answers /health over HTTP', async () => {
    const server = await start();

    const response = await fetch(`${server.address}/health`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
  });

  it('stops everything: HTTP, listener and database connections', async () => {
    const server = await start();
    await eventually(async () => (await listenerConnections()) === 1, 'listener connected');

    await server.stop();

    expect(server.app.server.listening).toBe(false);
    expect(await listenerConnections()).toBe(0);
    await expect(fetch(`${server.address}/health`)).rejects.toThrow();
    // A second call is harmless
    await server.stop();
  });

  it('keeps working after the database drops its connections', async () => {
    const server = await start();
    await testDb.pool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()`,
    );

    // The pool replaces broken connections, so the health check recovers by itself
    await eventually(
      async () => (await server.app.inject({ method: 'GET', url: '/health' })).statusCode === 200,
      'health recovers',
    );
    // ... and so does the listener
    await eventually(async () => (await listenerConnections()) === 1, 'listener reconnected');
  });

  it('removes the web connections its server left behind, and only those', async () => {
    const user = await createUser({ channel: 'web', telegramId: null, googleSub: 'g-1' });
    await testDb.db.insert(webConnections).values([
      { userId: user.id, serverId: 'server-1' },
      { userId: user.id, serverId: 'server-1' },
      { userId: user.id, serverId: 'server-2' },
    ]);

    await start({ SERVER_ID: 'server-1' });

    const left = await testDb.db.select().from(webConnections);
    expect(left.map((c) => c.serverId)).toEqual(['server-2']);
  });

  it('delivers outbox events at once through the dispatcher and the listener', async () => {
    const user = await createUser({ channel: 'web', telegramId: null, googleSub: 'g-2' });
    const delivered: OutboxDelivery[] = [];
    const server = await start(
      {},
      { adapters: { web: { deliver: async (delivery) => void delivered.push(delivery) } } },
    );
    await eventually(async () => (await listenerConnections()) === 1, 'listener connected');

    await server.core.run(async ({ tx }) =>
      ok(await emit(tx, user.id, { type: 'question.queued', questionId: 'q-1' })),
    );

    // The dispatcher timer is 60 s: only the notification explains a fast delivery
    await eventually(() => delivered.length === 1, 'delivery');
    expect(delivered[0]).toMatchObject({ userId: user.id, channel: 'web' });
  });

  it('runs the worker: an assignment past its deadline is timed out', async () => {
    const author = await createUser();
    await createUser();
    const server = await start({ WORKER_INTERVAL: '0.02' }, { time });
    const asked = await server.core.run((ctx) => askQuestion(ctx, author.id, 'Is anyone there?'));
    expect(asked.ok).toBe(true);
    const outcomes = async () =>
      (await testDb.pool.query<{ outcome: string | null }>('SELECT outcome FROM assignments')).rows;
    expect(await outcomes()).toEqual([{ outcome: null }]);

    // Past ANSWER_TIMEOUT (30 minutes by default)
    time.advance(31 * 60 * 1000);

    await eventually(async () => (await outcomes())[0]?.outcome === 'timed_out', 'time out');
  });

  it('reads product settings from the database', async () => {
    const server = await start();
    expect((await server.settings.get()).MESSAGE_MAX_LENGTH).toBe(2000);

    await server.settings.set({ MESSAGE_MAX_LENGTH: 100 });

    expect((await server.settings.get()).MESSAGE_MAX_LENGTH).toBe(100);
  });

  it('cleans up and reports the error when it cannot start', async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const { port } = blocker.address() as net.AddressInfo;

    await expect(startServer(config({ PORT: String(port), HOST: '127.0.0.1' }))).rejects.toThrow(
      /EADDRINUSE/,
    );

    await new Promise((resolve) => blocker.close(resolve));
    // Nothing is left running: the listener is closed too
    await eventually(async () => (await listenerConnections()) === 0, 'listener closed');
  });
});
