import { wsMessageSchema, type WsMessage } from '@human-msg/shared';

export type RealtimeStatus = 'connecting' | 'open' | 'reconnecting';

export interface RealtimeOptions {
  url: string;
  /** The connection is up (the first time and after every reconnection): re-read the state. */
  onOpen(): void;
  onMessage(message: WsMessage): void;
  onStatus?(status: RealtimeStatus): void;
  /** Injectable for tests. */
  WebSocketImpl?: typeof WebSocket;
  /** First pause before reconnecting; it doubles up to `maxDelayMs`. */
  minDelayMs?: number;
  maxDelayMs?: number;
}

/** Messages remembered to drop repeats (delivery is at least once). */
const SEEN_LIMIT = 200;

/**
 * Keeps one WebSocket to the server open: reconnects with a growing pause when it drops, and
 * reports every (re)connection through `onOpen`, because events sent while the socket was down
 * are lost and the screen has to be rebuilt from the server's state.
 */
export function startRealtime(options: RealtimeOptions): { close(): void } {
  const {
    url,
    onOpen,
    onMessage,
    onStatus,
    WebSocketImpl = WebSocket,
    minDelayMs = 1000,
    maxDelayMs = 30_000,
  } = options;

  let socket: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay = minDelayMs;
  let closed = false;
  let everOpened = false;
  const seen = new Set<number>();

  const connect = () => {
    if (closed) return;
    const current = new WebSocketImpl(url);
    socket = current;

    current.onopen = () => {
      if (closed || socket !== current) return;
      everOpened = true;
      delay = minDelayMs;
      onStatus?.('open');
      onOpen();
    };
    current.onmessage = (event) => {
      if (closed || socket !== current) return;
      let message: WsMessage;
      try {
        message = wsMessageSchema.parse(JSON.parse(String(event.data)));
      } catch (error) {
        console.warn('ignored an unreadable WebSocket message', error);
        return;
      }
      if (seen.has(message.id)) return;
      seen.add(message.id);
      if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value!);
      onMessage(message);
    };
    current.onclose = () => {
      if (closed || socket !== current) return;
      socket = undefined;
      onStatus?.(everOpened ? 'reconnecting' : 'connecting');
      timer = setTimeout(connect, delay);
      delay = Math.min(delay * 2, maxDelayMs);
    };
    // An error is always followed by `close`, which does the reconnecting
    current.onerror = () => {};
  };

  // A device that got its network back should not wait out the pause
  const onlineAgain = () => {
    if (closed || socket) return;
    clearTimeout(timer);
    delay = minDelayMs;
    connect();
  };
  window.addEventListener('online', onlineAgain);

  onStatus?.('connecting');
  connect();

  return {
    close() {
      closed = true;
      clearTimeout(timer);
      window.removeEventListener('online', onlineAgain);
      const current = socket;
      socket = undefined;
      current?.close();
    },
  };
}

/** `ws://` or `wss://` address of the API socket on the page's own host. */
export function realtimeUrl(location: Pick<Location, 'protocol' | 'host'> = window.location) {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`;
}
