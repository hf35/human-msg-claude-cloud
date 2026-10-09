import { OUTBOX_CHANNEL } from '@human-msg/core';
import pg from 'pg';

export interface OutboxListenerOptions {
  connectionString: string;
  /** Called on every notification, and once after every (re)connection to catch up. */
  onNotify: () => void;
  /** Called when the connection fails; the listener reconnects on its own. */
  onError?: (error: unknown) => void;
  /** Postgres channel to listen on. Default: the channel the core notifies. */
  channel?: string;
  /** Pause before a reconnection attempt. Default: 1 s. */
  reconnectDelayMs?: number;
}

export interface OutboxListener {
  /** Resolves when the first `LISTEN` is in place. Never rejects: failures are retried. */
  ready: Promise<void>;
  /** Closes the connection and stops reconnecting. */
  stop(): Promise<void>;
}

/**
 * Listens for `NOTIFY outbox`, which the core sends when a transaction that wrote an event
 * commits, so the dispatcher can deliver at once instead of waiting for the next periodic pass.
 *
 * `LISTEN` needs a connection of its own that stays open (a pooled one would be handed to other
 * work). Notifications are lost while it is down, so after every reconnection `onNotify` is
 * called once: whatever was written meanwhile is picked up. The periodic pass of the dispatcher
 * stays as the safety net.
 */
export function startOutboxListener(options: OutboxListenerOptions): OutboxListener {
  const {
    connectionString,
    onNotify,
    onError,
    channel = OUTBOX_CHANNEL,
    reconnectDelayMs = 1000,
  } = options;
  let stopped = false;
  let client: pg.Client | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => (markReady = resolve));

  const scheduleReconnect = () => {
    if (stopped) return;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, reconnectDelayMs);
  };

  async function connect() {
    if (stopped) return;
    const next = new pg.Client({ connectionString, keepAlive: true });
    let lost = false;
    // The connection can fail in several ways at once (error, then end); handle the loss once
    const onLost = (error?: unknown) => {
      if (lost) return;
      lost = true;
      if (client === next) client = undefined;
      if (!stopped && error !== undefined) onError?.(error);
      next.end().catch(() => {});
      scheduleReconnect();
    };
    next.on('error', onLost);
    next.on('end', () => onLost());
    next.on('notification', (message) => {
      if (message.channel === channel) onNotify();
    });
    try {
      await next.connect();
      await next.query(`LISTEN ${next.escapeIdentifier(channel)}`);
    } catch (error) {
      onLost(error);
      return;
    }
    if (stopped) {
      lost = true;
      await next.end().catch(() => {});
      return;
    }
    client = next;
    markReady();
    onNotify();
  }

  void connect();

  return {
    ready,
    async stop() {
      stopped = true;
      clearTimeout(retryTimer);
      const current = client;
      client = undefined;
      await current?.end().catch(() => {});
    },
  };
}
