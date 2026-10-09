import type { OutboxDelivery } from '@human-msg/core';
import { wsMessageSchema } from '@human-msg/shared';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createWebSocketAdapter } from './websocket';

const delivery: OutboxDelivery = {
  id: 7,
  userId: 'user-1',
  channel: 'web',
  locale: 'ru',
  event: { type: 'question.queued', questionId: 'q-1' },
  createdAt: new Date('2026-01-02T03:04:05.678Z'),
  attempt: 1,
};

/** Just enough of a socket for the adapter. */
function fakeSocket(options: { open?: boolean; fails?: boolean } = {}) {
  const sent: string[] = [];
  const socket = {
    readyState: options.open === false ? WebSocket.CLOSED : WebSocket.OPEN,
    send(data: string, callback: (error?: Error) => void) {
      sent.push(data);
      callback(options.fails ? new Error('socket is broken') : undefined);
    },
  };
  return { socket: socket as unknown as WebSocket, sent };
}

const hubOf = (sockets: WebSocket[]) => ({ sockets: () => sockets });

describe('WebSocket adapter', () => {
  it('sends the event to every open socket of the user', async () => {
    const a = fakeSocket();
    const b = fakeSocket();
    await createWebSocketAdapter(hubOf([a.socket, b.socket])).deliver(delivery);
    for (const { sent } of [a, b]) {
      expect(sent).toHaveLength(1);
      const message = wsMessageSchema.parse(JSON.parse(sent[0]!));
      expect(message).toEqual({
        id: 7,
        createdAt: '2026-01-02T03:04:05.678Z',
        event: { type: 'question.queued', questionId: 'q-1' },
      });
    }
  });

  it('counts the event as delivered when the user has no open socket', async () => {
    await expect(createWebSocketAdapter(hubOf([])).deliver(delivery)).resolves.toBeUndefined();
    const closed = fakeSocket({ open: false });
    await expect(
      createWebSocketAdapter(hubOf([closed.socket])).deliver(delivery),
    ).resolves.toBeUndefined();
    expect(closed.sent).toHaveLength(0);
  });

  it('skips closed sockets', async () => {
    const open = fakeSocket();
    const closed = fakeSocket({ open: false });
    await createWebSocketAdapter(hubOf([closed.socket, open.socket])).deliver(delivery);
    expect(open.sent).toHaveLength(1);
    expect(closed.sent).toHaveLength(0);
  });

  it('succeeds when at least one socket accepted the event', async () => {
    const broken = fakeSocket({ fails: true });
    const fine = fakeSocket();
    await expect(
      createWebSocketAdapter(hubOf([broken.socket, fine.socket])).deliver(delivery),
    ).resolves.toBeUndefined();
  });

  it('fails, so the event is retried, when every socket refused it', async () => {
    const broken = fakeSocket({ fails: true });
    await expect(createWebSocketAdapter(hubOf([broken.socket])).deliver(delivery)).rejects.toThrow(
      /no WebSocket/,
    );
  });
});
