import type { WsMessage } from '@human-msg/shared';
import { WebSocket } from 'ws';
import type { ConnectionHub } from '../web/ws';
import type { ChannelAdapter } from './dispatcher';

/**
 * Delivers outbox events of web users to every open WebSocket of the user on this server.
 *
 * A user without an open socket has nobody to deliver to: the event counts as delivered, because
 * the web client loads the current state over REST when it connects. If every socket refused the
 * message, the delivery fails and is retried.
 */
export function createWebSocketAdapter(hub: Pick<ConnectionHub, 'sockets'>): ChannelAdapter {
  return {
    async deliver(delivery) {
      const open = hub
        .sockets(delivery.userId)
        .filter((socket) => socket.readyState === WebSocket.OPEN);
      if (open.length === 0) return;

      const message: WsMessage = {
        id: delivery.id,
        createdAt: delivery.createdAt.toISOString(),
        event: delivery.event,
      };
      const payload = JSON.stringify(message);
      const results = await Promise.all(
        open.map(
          (socket) =>
            new Promise<boolean>((resolve) => socket.send(payload, (error) => resolve(!error))),
        ),
      );
      if (!results.some(Boolean)) throw new Error('no WebSocket accepted the event');
    },
  };
}
