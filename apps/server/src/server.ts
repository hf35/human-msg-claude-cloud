import {
  clearServerConnections,
  createCore,
  createSettingsStore,
  ok,
  startWorker,
  type Core,
  type SettingsStore,
} from '@human-msg/core';
import { createDb, createPool, type TimeSource } from '@human-msg/db';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app';
import type { Config } from './config';
import { startTelegram, type RunningTelegram } from './telegram';
import { createGoogleVerifier, type GoogleTokenVerifier } from './web/google';
import {
  createWebSocketAdapter,
  startDispatcher,
  startOutboxListener,
  type ChannelAdapters,
} from './delivery';

export interface StartServerOptions {
  /** Delivery adapters by channel; they replace the built-in ones (web: WebSocket). */
  adapters?: ChannelAdapters;
  /** Where "now" comes from; tests move it. Defaults to the database clock. */
  time?: TimeSource;
  /** Replaces the Google ID token check; tests supply one that needs no network. */
  googleVerifier?: GoogleTokenVerifier;
  /** Reconnection pause of the NOTIFY listener, in milliseconds. */
  listenerReconnectMs?: number;
}

export interface RunningServer {
  app: FastifyInstance;
  core: Core;
  settings: SettingsStore;
  /** Address the HTTP server listens on. */
  address: string;
  /** Graceful shutdown: stops HTTP first, then the background modules, then the database. */
  stop(): Promise<void>;
}

/**
 * Assembles and starts every module of the server process: the HTTP API, the worker, the outbox
 * dispatcher with its NOTIFY listener. The Telegram bot delivers through the same dispatcher. Modules talk to
 * the database only through the core.
 *
 * On start the server removes the web connections it had before a crash or restart. Schema
 * migrations are not applied here: they run as a separate step before the server starts.
 */
export async function startServer(
  config: Config,
  options: StartServerOptions = {},
): Promise<RunningServer> {
  const { adapters = {}, time, listenerReconnectMs } = options;
  const googleVerifier =
    options.googleVerifier ??
    (config.googleClientId ? createGoogleVerifier(config.googleClientId) : undefined);

  const pool = createPool(config.databaseUrl);
  const db = createDb(pool);
  const settings = createSettingsStore({ db });
  const core = createCore({ db, settings, ...(time && { time }) });

  const app = await buildApp({
    config,
    core,
    googleVerifier,
    serverId: config.serverId,
    wsPingIntervalMs: config.wsPingIntervalMs,
    healthCheck: async () => void (await pool.query('SELECT 1')),
  });
  // A broken idle connection must not crash the process; the pool replaces it
  pool.on('error', (error) => app.log.error({ err: error }, 'database pool error'));

  let worker: ReturnType<typeof startWorker> | undefined;
  let dispatcher: ReturnType<typeof startDispatcher> | undefined;
  let listener: ReturnType<typeof startOutboxListener> | undefined;
  let telegram: RunningTelegram | undefined;

  // Stops what is running, in the reverse order of starting; safe to call at any stage
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      await telegram?.stop();
      await app.close();
      await listener?.stop();
      await dispatcher?.stop();
      await worker?.stop();
      await pool.end();
    })());

  try {
    await core.run(async (ctx) => ok(await clearServerConnections(ctx, config.serverId)));

    worker = startWorker({
      core,
      intervalMs: config.workerIntervalMs,
      onError: (error) => app.log.error({ err: error }, 'worker pass failed'),
    });
    // Before listening: a wrong token must stop the start, not leave a server without its bot.
    // Started before the dispatcher, which delivers Telegram events through the bot
    if (config.telegram) {
      telegram = await startTelegram({
        token: config.telegram.token,
        core,
        app,
        mode: config.telegram.mode,
        ...(config.telegram.webhook && { webhook: config.telegram.webhook }),
        ...(config.telegram.apiRoot && { apiRoot: config.telegram.apiRoot }),
        log: {
          info: (message) => app.log.info(message),
          error: (object, message) => app.log.error(object, message),
        },
      });
    }

    dispatcher = startDispatcher({
      core,
      adapters: {
        web: createWebSocketAdapter(app.connections),
        ...(telegram && { telegram: telegram.adapter }),
        ...adapters,
      },
      intervalMs: config.dispatchIntervalMs,
      onFailure: ({ delivery, error, willRetry }) =>
        app.log.warn({ err: error, delivery, willRetry }, 'event delivery failed'),
      onError: (error) => app.log.error({ err: error }, 'dispatcher pass failed'),
    });
    listener = startOutboxListener({
      connectionString: config.databaseUrl,
      onNotify: () => dispatcher?.wake(),
      onError: (error) => app.log.warn({ err: error }, 'outbox listener lost its connection'),
      reconnectDelayMs: listenerReconnectMs,
    });

    const address = await app.listen({ host: config.host, port: config.port });
    return { app, core, settings, address, stop };
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }
}
