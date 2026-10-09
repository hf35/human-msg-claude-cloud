import {
  dispatchOutbox,
  type Core,
  type DeliveryFailure,
  type DispatchResult,
  type OutboxDelivery,
} from '@human-msg/core';
import type { UserChannel } from '@human-msg/db';

/** Sends events to one channel (WebSocket, Telegram). Resolving means delivered. */
export interface ChannelAdapter {
  /** Rejecting means "try again later"; the dispatcher schedules the retry. */
  deliver(delivery: OutboxDelivery): Promise<void>;
}

/** Adapters by channel. A channel without an adapter is skipped: its events wait in the outbox. */
export type ChannelAdapters = Partial<Record<UserChannel, ChannelAdapter>>;

export interface DispatcherOptions {
  core: Core;
  adapters: ChannelAdapters;
  /** Pause between the end of one pass and the start of the next. */
  intervalMs: number;
  /** Called when a delivery fails (it is retried or given up on). */
  onFailure?: (failure: DeliveryFailure) => void;
  /** Called when a whole pass fails, for example when the database is unreachable. */
  onError?: (error: unknown) => void;
}

export interface Dispatcher {
  /** Stops scheduling passes and waits for the current one to finish. */
  stop(): Promise<void>;
}

/** One pass: delivers every due event of the channels that have an adapter. */
export function dispatchOnce(
  options: Pick<DispatcherOptions, 'core' | 'adapters' | 'onFailure'>,
): Promise<DispatchResult> {
  const { core, adapters, onFailure } = options;
  const channels = (Object.keys(adapters) as UserChannel[]).filter((channel) => adapters[channel]);
  return dispatchOutbox(core, {
    channels,
    deliver: (delivery) => adapters[delivery.channel]!.deliver(delivery),
    onFailure,
  });
}

/**
 * Delivers outbox events every `intervalMs`. The next pass is scheduled only after the previous
 * one has finished, so passes of one dispatcher never overlap. A failed pass is reported to
 * `onError` and does not stop the dispatcher. Several dispatchers (or server instances) may run
 * at once: an event is taken by one of them.
 */
export function startDispatcher(options: DispatcherOptions): Dispatcher {
  const { intervalMs, onError } = options;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: Promise<void> = Promise.resolve();

  const pass = async () => {
    try {
      await dispatchOnce(options);
    } catch (error) {
      onError?.(error);
    }
  };
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      current = pass().finally(schedule);
    }, intervalMs);
  };
  schedule();

  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await current;
    },
  };
}
