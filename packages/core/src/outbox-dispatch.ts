import { outbox, users, type UserChannel, type UserLocale } from '@human-msg/db';
import { joinEvent, type DomainEvent } from '@human-msg/shared';
import { and, asc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { Core } from './core';
import { ok } from './result';

/** An outbox event handed to a channel adapter. */
export interface OutboxDelivery {
  /** Clients tell events apart by this id and ignore repeats (delivery is at least once). */
  id: number;
  userId: string;
  channel: UserChannel;
  locale: UserLocale;
  event: DomainEvent;
  createdAt: Date;
  /** 1 for the first try, 2 for the first retry, and so on. */
  attempt: number;
}

/** Delivers one event to the user's channel. Resolving means delivered; rejecting means retry. */
export type DeliverEvent = (delivery: OutboxDelivery) => Promise<void>;

/** Why an event was not delivered on this try, and what happens to it next. */
export interface DeliveryFailure {
  delivery: Pick<OutboxDelivery, 'id' | 'userId' | 'channel' | 'attempt'>;
  error: unknown;
  /** `false` when the event was given up on: it will not be tried again. */
  willRetry: boolean;
}

export interface DispatchOptions {
  /** Only events of users of these channels are taken; the others stay in the outbox. */
  channels: readonly UserChannel[];
  deliver: DeliverEvent;
  /** Most events handled in one call. Default: 100. */
  batchSize?: number;
  /** After this many failed tries an event is given up on. Default: 8. */
  maxAttempts?: number;
  /** A delivery that takes longer counts as failed. Default: 15 s, well below the idle limit. */
  deliverTimeoutMs?: number;
  /** Called for every failed try. Must not throw. */
  onFailure?: (failure: DeliveryFailure) => void;
}

export interface DispatchResult {
  delivered: number;
  /** Failed tries that will be repeated. */
  retried: number;
  /** Events given up on. */
  gaveUp: number;
}

export const RETRY_BASE_SECONDS = 5;
export const RETRY_MAX_SECONDS = 15 * 60;

/** Pause before the next try after `attempts` failed ones: 5 s, 10 s, 20 s ... up to 15 minutes. */
export function retryDelaySeconds(attempts: number): number {
  return Math.min(RETRY_BASE_SECONDS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_SECONDS);
}

type Handled = 'none' | keyof DispatchResult;

const MAX_ERROR_LENGTH = 500;
const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_LENGTH);

class DeliveryTimeout extends Error {
  constructor(ms: number) {
    super(`delivery took longer than ${ms} ms`);
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DeliveryTimeout(ms)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Delivers due outbox events, oldest first, until none is left or `batchSize` is reached.
 *
 * Each event is handled in its own transaction under `FOR UPDATE SKIP LOCKED`, so several
 * dispatchers may run at once and an event is taken by one of them; a stuck event does not hold
 * the others back. The row stays locked while the adapter works, hence the delivery timeout.
 *
 * - Delivered: `delivered_at` is set.
 * - Failed: `attempts` grows and the next try is scheduled after a growing pause. After
 *   `maxAttempts`, or at once for an event that cannot be read back, the event is given up on:
 *   `delivered_at` is set so it is not picked again and `last_error` tells it was not delivered.
 *
 * Delivery is at least once: if the process dies after the adapter sent the event but before the
 * commit, the event is sent again. Clients ignore repeats by `id`.
 */
export async function dispatchOutbox(
  core: Core,
  options: DispatchOptions,
): Promise<DispatchResult> {
  const {
    channels,
    deliver,
    batchSize = 100,
    maxAttempts = 8,
    deliverTimeoutMs = 15_000,
    onFailure,
  } = options;
  const result: DispatchResult = { delivered: 0, retried: 0, gaveUp: 0 };
  if (channels.length === 0) return result;

  while (result.delivered + result.retried + result.gaveUp < batchSize) {
    const handled = await core.run(async ({ tx, time }) => {
      const [row] = await tx
        .select({
          id: outbox.id,
          userId: outbox.userId,
          type: outbox.type,
          payload: outbox.payload,
          createdAt: outbox.createdAt,
          attempts: outbox.attempts,
          channel: users.channel,
          locale: users.locale,
        })
        .from(outbox)
        .innerJoin(users, eq(users.id, outbox.userId))
        .where(
          and(
            isNull(outbox.deliveredAt),
            lte(outbox.nextAttemptAt, time.now()),
            inArray(users.channel, [...channels]),
          ),
        )
        .orderBy(asc(outbox.nextAttemptAt), asc(outbox.id))
        .limit(1)
        .for('update', { of: outbox, skipLocked: true });
      if (!row) return ok<Handled>('none');

      const attempt = row.attempts + 1;
      const info = { id: row.id, userId: row.userId, channel: row.channel, attempt };

      let failure: { error: unknown; permanent: boolean } | undefined;
      let event: DomainEvent | undefined;
      try {
        event = joinEvent(row.type, row.payload);
      } catch (error) {
        // A row that does not match any known event will not get better with retries
        failure = { error, permanent: true };
      }
      if (event) {
        try {
          await withTimeout(
            deliver({ ...info, locale: row.locale, event, createdAt: row.createdAt }),
            deliverTimeoutMs,
          );
        } catch (error) {
          failure = { error, permanent: false };
        }
      }

      if (!failure) {
        await tx
          .update(outbox)
          .set({ attempts: attempt, deliveredAt: time.now(), lastError: null })
          .where(eq(outbox.id, row.id));
        return ok<Handled>('delivered');
      }

      const giveUp = failure.permanent || attempt >= maxAttempts;
      await tx
        .update(outbox)
        .set(
          giveUp
            ? { attempts: attempt, deliveredAt: time.now(), lastError: errorText(failure.error) }
            : {
                attempts: attempt,
                nextAttemptAt: sql`${time.now()} + ${retryDelaySeconds(attempt)} * interval '1 second'`,
                lastError: errorText(failure.error),
              },
        )
        .where(eq(outbox.id, row.id));
      onFailure?.({ delivery: info, error: failure.error, willRetry: !giveUp });
      return ok<Handled>(giveUp ? 'gaveUp' : 'retried');
    });
    if (!handled.ok || handled.value === 'none') break;
    result[handled.value]++;
  }
  return result;
}
