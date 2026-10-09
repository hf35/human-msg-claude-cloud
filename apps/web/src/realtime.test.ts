import type { WsMessage } from '@human-msg/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { realtimeUrl, startRealtime, type RealtimeStatus } from './realtime';
import { FakeWebSocket } from './test-utils';

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
});
afterEach(() => vi.useRealTimers());

const queued = (id: number): WsMessage => ({
  id,
  createdAt: '2026-01-01T00:00:00.000Z',
  event: { type: 'question.queued', questionId: 'q1' },
});

function start() {
  const opens = vi.fn();
  const messages: WsMessage[] = [];
  const statuses: RealtimeStatus[] = [];
  const connection = startRealtime({
    url: 'ws://test/api/ws',
    onOpen: opens,
    onMessage: (m) => messages.push(m),
    onStatus: (s) => statuses.push(s),
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
  });
  return { connection, opens, messages, statuses };
}

describe('startRealtime', () => {
  it('connects, reports the opening and passes messages on', () => {
    const { opens, messages, statuses } = start();
    expect(FakeWebSocket.last.url).toBe('ws://test/api/ws');
    expect(statuses).toEqual(['connecting']);

    FakeWebSocket.last.open();
    expect(opens).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual(['connecting', 'open']);

    FakeWebSocket.last.send(queued(1));
    expect(messages).toEqual([queued(1)]);
  });

  it('drops a message it has already seen', () => {
    const { messages } = start();
    FakeWebSocket.last.open();
    FakeWebSocket.last.send(queued(1));
    FakeWebSocket.last.send(queued(1));
    FakeWebSocket.last.send(queued(2));
    expect(messages.map((m) => m.id)).toEqual([1, 2]);
  });

  it('ignores unreadable messages', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { messages } = start();
    FakeWebSocket.last.open();
    FakeWebSocket.last.sendRaw('not json');
    FakeWebSocket.last.sendRaw(JSON.stringify({ id: 1, event: { type: 'nonsense' } }));
    FakeWebSocket.last.send(queued(3));
    expect(messages.map((m) => m.id)).toEqual([3]);
  });

  it('reconnects after a drop and asks for the state again', () => {
    const { opens, statuses } = start();
    FakeWebSocket.last.open();
    FakeWebSocket.last.drop();
    expect(statuses.at(-1)).toBe('reconnecting');
    expect(FakeWebSocket.instances).toHaveLength(1);

    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.last.open();
    expect(opens).toHaveBeenCalledTimes(2);
    expect(statuses.at(-1)).toBe('open');
  });

  it('waits longer after each failed attempt and starts over after a success', () => {
    start();
    // Attempts that never open: 1 s, 2 s, 4 s ...
    FakeWebSocket.last.drop();
    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);

    FakeWebSocket.last.drop();
    vi.advanceTimersByTime(1999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(3);

    FakeWebSocket.last.open();
    FakeWebSocket.last.drop();
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it('never waits longer than the maximum', () => {
    start();
    for (let i = 0; i < 12; i++) {
      FakeWebSocket.last.drop();
      vi.advanceTimersByTime(30_000);
    }
    const count = FakeWebSocket.instances.length;
    expect(count).toBe(13);
  });

  it('reconnects at once when the network comes back', () => {
    start();
    FakeWebSocket.last.open();
    FakeWebSocket.last.drop();
    window.dispatchEvent(new Event('online'));
    expect(FakeWebSocket.instances).toHaveLength(2);
    // The pending timer must not open a third connection
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('close() stops everything', () => {
    const { connection, opens, messages } = start();
    FakeWebSocket.last.open();
    const socket = FakeWebSocket.last;
    connection.close();
    expect(socket.closed).toBe(true);

    socket.drop();
    socket.send(queued(1));
    vi.advanceTimersByTime(60_000);
    window.dispatchEvent(new Event('online'));
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(messages).toEqual([]);
    expect(opens).toHaveBeenCalledTimes(1);
  });
});

describe('realtimeUrl', () => {
  it('follows the protocol of the page', () => {
    expect(realtimeUrl({ protocol: 'http:', host: 'localhost:5173' })).toBe(
      'ws://localhost:5173/api/ws',
    );
    expect(realtimeUrl({ protocol: 'https:', host: 'example.org' })).toBe(
      'wss://example.org/api/ws',
    );
  });
});
