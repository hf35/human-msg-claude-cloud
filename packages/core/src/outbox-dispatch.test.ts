import { createManualTime, outbox, users, type NewUser } from '@human-msg/db';
import { createTestDatabase, type TestDatabase } from '@human-msg/db/testing';
import type { DomainEvent } from '@human-msg/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCore } from './core';
import { emit } from './outbox';
import {
  dispatchOutbox,
  retryDelaySeconds,
  type DeliveryFailure,
  type OutboxDelivery,
} from './outbox-dispatch';
import { ok } from './result';

let testDb: TestDatabase;
const time = createManualTime();

beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(() => testDb.close());
beforeEach(async () => {
  time.reset();
  await testDb.reset();
});

const core = () => createCore({ db: testDb.db, time });
let counter = 0;

async function createUser(values: Partial<NewUser> = {}) {
  counter++;
  const [user] = await testDb.db
    .insert(users)
    .values({ alias: `Dispatch ${counter}`, channel: 'web', googleSub: `d-${counter}`, ...values })
    .returning();
  return user!;
}

const queued = (questionId: string): DomainEvent => ({ type: 'question.queued', questionId });

async function emitFor(userId: string, event: DomainEvent) {
  return core().run(async ({ tx }) => ok(await emit(tx, userId, event)));
}

const row = async (id: number) =>
  (await testDb.db.select().from(outbox).where(eq(outbox.id, id)))[0]!;

/** An adapter that records what it was given. */
function recorder() {
  const seen: OutboxDelivery[] = [];
  return {
    seen,
    deliver: async (delivery: OutboxDelivery) => void seen.push(delivery),
  };
}

describe('retryDelaySeconds', () => {
  it('doubles from 5 seconds and stops growing at 15 minutes', () => {
    expect([1, 2, 3, 4].map(retryDelaySeconds)).toEqual([5, 10, 20, 40]);
    expect(retryDelaySeconds(8)).toBe(640);
    expect(retryDelaySeconds(9)).toBe(900);
    expect(retryDelaySeconds(500)).toBe(900);
  });
});

describe('dispatchOutbox', () => {
  it('delivers events oldest first and marks them delivered', async () => {
    const user = await createUser({ locale: 'en' });
    const first = await emitFor(user.id, queued('q-1'));
    const second = await emitFor(user.id, queued('q-2'));
    const adapter = recorder();

    const result = await dispatchOutbox(core(), { channels: ['web'], deliver: adapter.deliver });

    expect(result).toEqual({ delivered: 2, retried: 0, gaveUp: 0 });
    expect(adapter.seen.map((d) => d.id)).toEqual([
      first.ok && first.value,
      second.ok && second.value,
    ]);
    expect(adapter.seen[0]).toMatchObject({
      userId: user.id,
      channel: 'web',
      locale: 'en',
      event: { type: 'question.queued', questionId: 'q-1' },
      attempt: 1,
    });
    const stored = await row(adapter.seen[0]!.id);
    expect(stored.deliveredAt).not.toBeNull();
    expect(stored.attempts).toBe(1);
    expect(stored.lastError).toBeNull();
  });

  it('does not deliver an event twice', async () => {
    const user = await createUser();
    await emitFor(user.id, queued('q-1'));
    const adapter = recorder();
    await dispatchOutbox(core(), { channels: ['web'], deliver: adapter.deliver });
    const again = await dispatchOutbox(core(), { channels: ['web'], deliver: adapter.deliver });
    expect(again.delivered).toBe(0);
    expect(adapter.seen).toHaveLength(1);
  });

  it('leaves events of other channels in the outbox', async () => {
    const web = await createUser();
    const telegram = await createUser({ channel: 'telegram', googleSub: null, telegramId: 777 });
    await emitFor(web.id, queued('q-web'));
    const forTelegram = await emitFor(telegram.id, queued('q-tg'));
    const adapter = recorder();

    await dispatchOutbox(core(), { channels: ['web'], deliver: adapter.deliver });

    expect(adapter.seen.map((d) => d.channel)).toEqual(['web']);
    expect((await row(forTelegram.ok ? forTelegram.value : 0)).deliveredAt).toBeNull();
  });

  it('does nothing without channels', async () => {
    const user = await createUser();
    await emitFor(user.id, queued('q-1'));
    const adapter = recorder();
    const result = await dispatchOutbox(core(), { channels: [], deliver: adapter.deliver });
    expect(result).toEqual({ delivered: 0, retried: 0, gaveUp: 0 });
    expect(adapter.seen).toHaveLength(0);
  });

  it('handles at most batchSize events per call', async () => {
    const user = await createUser();
    for (let i = 0; i < 5; i++) await emitFor(user.id, queued(`q-${i}`));
    const adapter = recorder();
    const result = await dispatchOutbox(core(), {
      channels: ['web'],
      deliver: adapter.deliver,
      batchSize: 3,
    });
    expect(result.delivered).toBe(3);
    expect(adapter.seen).toHaveLength(3);
  });

  describe('when delivery fails', () => {
    it('schedules a retry with a growing pause and delivers it when due', async () => {
      const user = await createUser();
      const emitted = await emitFor(user.id, queued('q-1'));
      const id = emitted.ok ? emitted.value : 0;
      let failures = 2;
      const attempts: number[] = [];
      const deliver = async (delivery: OutboxDelivery) => {
        attempts.push(delivery.attempt);
        if (failures-- > 0) throw new Error('network is down');
      };
      const failed: DeliveryFailure[] = [];
      const run = () =>
        dispatchOutbox(core(), { channels: ['web'], deliver, onFailure: (f) => failed.push(f) });

      // First try fails: retry in 5 seconds
      expect(await run()).toEqual({ delivered: 0, retried: 1, gaveUp: 0 });
      let stored = await row(id);
      expect(stored).toMatchObject({
        attempts: 1,
        deliveredAt: null,
        lastError: 'network is down',
      });
      expect(failed[0]).toMatchObject({ willRetry: true, delivery: { id, attempt: 1 } });

      // Not due yet
      expect(await run()).toEqual({ delivered: 0, retried: 0, gaveUp: 0 });
      time.advance(5_000);

      // Second try fails: retry in 10 seconds
      expect(await run()).toEqual({ delivered: 0, retried: 1, gaveUp: 0 });
      time.advance(9_000);
      expect(await run()).toEqual({ delivered: 0, retried: 0, gaveUp: 0 });
      time.advance(1_000);

      // Third try succeeds
      expect(await run()).toEqual({ delivered: 1, retried: 0, gaveUp: 0 });
      stored = await row(id);
      expect(stored.deliveredAt).not.toBeNull();
      expect(stored.attempts).toBe(3);
      expect(stored.lastError).toBeNull();
      expect(attempts).toEqual([1, 2, 3]);
    });

    it('does not hold back the events of other users', async () => {
      const a = await createUser();
      const b = await createUser();
      await emitFor(a.id, queued('q-a'));
      await emitFor(b.id, queued('q-b'));
      const delivered: string[] = [];
      const result = await dispatchOutbox(core(), {
        channels: ['web'],
        deliver: async (delivery) => {
          if (delivery.userId === a.id) throw new Error('boom');
          delivered.push(delivery.userId);
        },
      });
      expect(result).toEqual({ delivered: 1, retried: 1, gaveUp: 0 });
      expect(delivered).toEqual([b.id]);
    });

    it('gives up after maxAttempts and keeps the error', async () => {
      const user = await createUser();
      const emitted = await emitFor(user.id, queued('q-1'));
      const id = emitted.ok ? emitted.value : 0;
      const failed: DeliveryFailure[] = [];
      const run = () =>
        dispatchOutbox(core(), {
          channels: ['web'],
          maxAttempts: 2,
          deliver: async () => {
            throw new Error('still down');
          },
          onFailure: (f) => failed.push(f),
        });

      expect((await run()).retried).toBe(1);
      time.advance(60_000);
      expect(await run()).toEqual({ delivered: 0, retried: 0, gaveUp: 1 });

      const stored = await row(id);
      expect(stored).toMatchObject({ attempts: 2, lastError: 'still down' });
      expect(stored.deliveredAt).not.toBeNull();
      expect(failed.map((f) => f.willRetry)).toEqual([true, false]);

      // Given up for good
      time.advance(3_600_000);
      expect((await run()).gaveUp).toBe(0);
    });

    it('gives up at once on an event that cannot be read back', async () => {
      const user = await createUser();
      const [inserted] = await testDb.db
        .insert(outbox)
        .values({ userId: user.id, type: 'no.such.event', payload: {} })
        .returning();
      let called = false;
      const result = await dispatchOutbox(core(), {
        channels: ['web'],
        deliver: async () => void (called = true),
      });
      expect(result).toEqual({ delivered: 0, retried: 0, gaveUp: 1 });
      expect(called).toBe(false);
      expect((await row(inserted!.id)).lastError).not.toBeNull();
    });

    it('counts a delivery that takes too long as failed', async () => {
      const user = await createUser();
      const emitted = await emitFor(user.id, queued('q-1'));
      const result = await dispatchOutbox(core(), {
        channels: ['web'],
        deliverTimeoutMs: 50,
        deliver: () => new Promise(() => {}),
      });
      expect(result.retried).toBe(1);
      const stored = await row(emitted.ok ? emitted.value : 0);
      expect(stored.deliveredAt).toBeNull();
      expect(stored.lastError).toMatch(/longer than 50 ms/);
    });
  });

  it('delivers each event once when several dispatchers run at the same time', async () => {
    const users_ = await Promise.all([createUser(), createUser(), createUser()]);
    for (let i = 0; i < 30; i++) await emitFor(users_[i % 3]!.id, queued(`q-${i}`));
    const counts = new Map<number, number>();
    const deliver = async (delivery: OutboxDelivery) => {
      counts.set(delivery.id, (counts.get(delivery.id) ?? 0) + 1);
      // Give the other dispatchers time to reach the same rows
      await new Promise((resolve) => setTimeout(resolve, 5));
    };

    const results = await Promise.all(
      [1, 2, 3, 4].map(() => dispatchOutbox(core(), { channels: ['web'], deliver })),
    );

    expect(counts.size).toBe(30);
    expect([...counts.values()].every((n) => n === 1)).toBe(true);
    expect(results.reduce((sum, r) => sum + r.delivered, 0)).toBe(30);
  });
});
