import { createCore, emit, ok, type Core, type OutboxDelivery } from '@human-msg/core';
import { createManualTime, users, type NewUser } from '@human-msg/db';
import { createTestDatabase, type TestDatabase } from '@human-msg/db/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dispatchOnce, startDispatcher, type Dispatcher } from './dispatcher';

let testDb: TestDatabase;
const time = createManualTime();
let core: Core;
let running: Dispatcher | undefined;

beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(() => testDb.close());
beforeEach(async () => {
  time.reset();
  await testDb.reset();
  core = createCore({ db: testDb.db, time });
});
afterEach(async () => {
  await running?.stop();
  running = undefined;
});

let counter = 0;
async function createUser(values: Partial<NewUser> = {}) {
  counter++;
  const [user] = await testDb.db
    .insert(users)
    .values({ alias: `Server ${counter}`, channel: 'web', googleSub: `s-${counter}`, ...values })
    .returning();
  return user!;
}

async function emitQueued(userId: string, questionId = 'q-1') {
  const result = await core.run(async ({ tx }) =>
    ok(await emit(tx, userId, { type: 'question.queued', questionId })),
  );
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

const deliveredAt = async (id: number) => {
  const { rows } = await testDb.pool.query<{ delivered_at: Date | null }>(
    'SELECT delivered_at FROM outbox WHERE id = $1',
    [id],
  );
  return rows[0]!.delivered_at;
};

/** A fake channel adapter: records deliveries and fails as long as `failures` is positive. */
function fakeAdapter(failures = 0) {
  const calls: OutboxDelivery[] = [];
  let left = failures;
  return {
    calls,
    deliver: async (delivery: OutboxDelivery) => {
      calls.push(delivery);
      if (left-- > 0) throw new Error('channel is down');
    },
  };
}

const eventually = async (check: () => Promise<boolean> | boolean) => {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition not reached in time');
};

describe('dispatchOnce', () => {
  it('hands an event to the adapter of the user channel and marks it delivered', async () => {
    const user = await createUser();
    const id = await emitQueued(user.id);
    const web = fakeAdapter();
    const telegram = fakeAdapter();

    const result = await dispatchOnce({ core, adapters: { web, telegram } });

    expect(result.delivered).toBe(1);
    expect(web.calls).toHaveLength(1);
    expect(web.calls[0]).toMatchObject({ id, userId: user.id, channel: 'web' });
    expect(telegram.calls).toHaveLength(0);
    expect(await deliveredAt(id)).not.toBeNull();
  });

  it('routes events of different channels to their own adapters', async () => {
    const web = await createUser();
    const telegram = await createUser({ channel: 'telegram', googleSub: null, telegramId: 55 });
    await emitQueued(web.id);
    await emitQueued(telegram.id);
    const webAdapter = fakeAdapter();
    const telegramAdapter = fakeAdapter();

    await dispatchOnce({ core, adapters: { web: webAdapter, telegram: telegramAdapter } });

    expect(webAdapter.calls.map((d) => d.userId)).toEqual([web.id]);
    expect(telegramAdapter.calls.map((d) => d.userId)).toEqual([telegram.id]);
  });

  it('keeps events of a channel without an adapter until one appears', async () => {
    const telegram = await createUser({ channel: 'telegram', googleSub: null, telegramId: 56 });
    const id = await emitQueued(telegram.id);

    expect((await dispatchOnce({ core, adapters: {} })).delivered).toBe(0);
    expect((await dispatchOnce({ core, adapters: { web: fakeAdapter() } })).delivered).toBe(0);
    expect(await deliveredAt(id)).toBeNull();

    const late = fakeAdapter();
    await dispatchOnce({ core, adapters: { telegram: late } });
    expect(late.calls).toHaveLength(1);
    expect(await deliveredAt(id)).not.toBeNull();
  });

  it('retries after an adapter error once the pause is over', async () => {
    const user = await createUser();
    const id = await emitQueued(user.id);
    const adapter = fakeAdapter(1);
    const failures: boolean[] = [];
    const run = () =>
      dispatchOnce({
        core,
        adapters: { web: adapter },
        onFailure: (failure) => failures.push(failure.willRetry),
      });

    expect(await run()).toMatchObject({ delivered: 0, retried: 1 });
    expect(await deliveredAt(id)).toBeNull();
    expect(failures).toEqual([true]);

    // The pause has not passed yet
    expect(await run()).toMatchObject({ delivered: 0, retried: 0 });
    expect(adapter.calls).toHaveLength(1);

    time.advance(5_000);
    expect(await run()).toMatchObject({ delivered: 1, retried: 0 });
    expect(adapter.calls.map((d) => d.attempt)).toEqual([1, 2]);
    expect(await deliveredAt(id)).not.toBeNull();
  });
});

describe('startDispatcher', () => {
  it('delivers events on its own schedule', async () => {
    const user = await createUser();
    const id = await emitQueued(user.id);
    const adapter = fakeAdapter();

    running = startDispatcher({ core, adapters: { web: adapter }, intervalMs: 20 });

    await eventually(async () => (await deliveredAt(id)) !== null);
    expect(adapter.calls).toHaveLength(1);
  });

  it('picks up events that appear later', async () => {
    const user = await createUser();
    const adapter = fakeAdapter();
    running = startDispatcher({ core, adapters: { web: adapter }, intervalMs: 20 });

    const id = await emitQueued(user.id);

    await eventually(async () => (await deliveredAt(id)) !== null);
  });

  it('keeps running after a failed pass and reports it', async () => {
    const user = await createUser();
    const id = await emitQueued(user.id);
    const errors: unknown[] = [];
    let broken = true;
    const brokenCore: Core = {
      run: (command) => {
        if (broken) return Promise.reject(new Error('database is unreachable'));
        return core.run(command);
      },
    };

    running = startDispatcher({
      core: brokenCore,
      adapters: { web: fakeAdapter() },
      intervalMs: 20,
      onError: (error) => errors.push(error),
    });
    await eventually(() => errors.length > 0);
    expect(String(errors[0])).toMatch(/unreachable/);

    broken = false;
    await eventually(async () => (await deliveredAt(id)) !== null);
  });

  it('stop() waits for the current pass and no more passes follow', async () => {
    const user = await createUser();
    const id = await emitQueued(user.id);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => (started = resolve));
    const deliver = async () => {
      started();
      await gate;
    };

    const dispatcher = startDispatcher({ core, adapters: { web: { deliver } }, intervalMs: 10 });
    await inFlight;
    let stopped = false;
    const stopping = dispatcher.stop().then(() => (stopped = true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stopped).toBe(false);

    release();
    await stopping;
    expect(await deliveredAt(id)).not.toBeNull();

    // Nothing is delivered after stop()
    const later = await emitQueued(user.id, 'q-2');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await deliveredAt(later)).toBeNull();
  });
});
