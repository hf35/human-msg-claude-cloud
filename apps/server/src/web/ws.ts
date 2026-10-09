import websocket from '@fastify/websocket';
import { connect, disconnect, type Core } from '@human-msg/core';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';

declare module 'fastify' {
  interface FastifyInstance {
    connections: ConnectionHub;
  }
}

/** Open WebSocket connections of this server process, by user. */
export interface ConnectionHub {
  /** The open sockets of a user (a user may have several tabs). */
  sockets(userId: string): WebSocket[];
  /** Number of open sockets of all users. */
  size(): number;
}

export interface WebSocketOptions {
  core: Core;
  /** Names this server's rows in `web_connections`. */
  serverId: string;
  /** Pause between pings; a socket that did not answer the previous ping is closed. */
  pingIntervalMs: number;
}

/** Close code for "the server could not serve this connection" (RFC 6455, 1011). */
const INTERNAL_ERROR = 1011;

/**
 * `GET /api/ws`: the WebSocket of a signed-in user (same cookie as the REST API). An open socket
 * makes the user available for questions: it is recorded in the core on open (which also hands
 * out a waiting question) and removed on close. Dead connections are found by ping/pong and
 * closed, so a user who vanished without a goodbye stops receiving questions.
 *
 * The socket is one-way: the server sends events, whatever the client sends is ignored.
 */
export async function registerWebSocket(
  app: FastifyInstance,
  options: WebSocketOptions,
): Promise<void> {
  const { core, serverId, pingIntervalMs } = options;
  await app.register(websocket);

  const byUser = new Map<string, Set<WebSocket>>();
  const alive = new WeakMap<WebSocket, boolean>();
  // Cleanups still running, so that shutdown can wait for them before the database closes
  const pending = new Set<Promise<void>>();

  app.decorate('connections', {
    sockets: (userId) => [...(byUser.get(userId) ?? [])],
    size: () => [...byUser.values()].reduce((sum, set) => sum + set.size, 0),
  } satisfies ConnectionHub);

  app.get(
    '/api/ws',
    { websocket: true, preHandler: app.sessions.requireUser },
    (socket, request) => {
      const userId = request.user!.id;
      alive.set(socket, true);
      socket.on('pong', () => alive.set(socket, true));
      socket.on('error', () => socket.terminate());

      // In the hub before the core hears about it: the question handed out on connect must be
      // able to find this socket
      let sockets = byUser.get(userId);
      if (!sockets) byUser.set(userId, (sockets = new Set()));
      sockets.add(socket);

      const registered = core
        .run((ctx) => connect(ctx, userId, serverId))
        .then((result) => (result.ok ? result.value.connectionId : undefined));
      registered.catch((error) => {
        request.log.error({ err: error }, 'could not register the web connection');
        socket.close(INTERNAL_ERROR);
      });

      const finished: Promise<void> = new Promise<void>((resolve) => {
        socket.once('close', () => {
          sockets.delete(socket);
          if (sockets.size === 0) byUser.delete(userId);
          registered
            .then((id) => (id ? core.run((ctx) => disconnect(ctx, id)) : undefined))
            .catch((error) => request.log.error({ err: error }, 'could not remove the connection'))
            .finally(resolve);
        });
      }).finally(() => pending.delete(finished));
      pending.add(finished);
    },
  );

  const timer = setInterval(() => {
    for (const set of byUser.values()) {
      for (const socket of set) {
        if (alive.get(socket) === false) {
          socket.terminate();
          continue;
        }
        alive.set(socket, false);
        socket.ping();
      }
    }
  }, pingIntervalMs);
  timer.unref();

  app.addHook('onClose', async () => {
    clearInterval(timer);
    for (const set of byUser.values()) for (const socket of set) socket.terminate();
    await Promise.allSettled([...pending]);
  });
}
