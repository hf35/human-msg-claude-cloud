import Fastify, { type FastifyInstance } from 'fastify';
import type { Core } from '@human-msg/core';
import type { Config } from './config';
import { registerAdminUsers } from './admin/users';
import { registerAdminAuth, type AdminAuthOptions } from './admin/auth';
import { registerActionRoutes } from './web/actions';
import { registerHistoryRoutes } from './web/history';
import { registerAuthRoutes } from './web/auth';
import type { GoogleTokenVerifier } from './web/google';
import { registerSessions } from './web/session';
import { registerStateRoutes } from './web/state';
import { registerWebSocket } from './web/ws';

export interface AppOptions {
  config: Pick<Config, 'logLevel'> & Partial<Pick<Config, 'nodeEnv' | 'devLogin'>>;
  /** Back office sign-in; without it the back office API answers 503. */
  backoffice?: Config['backoffice'];
  /** Limits and clock of the back office sign-in; tests tighten them. */
  backofficeAuth?: Pick<AdminAuthOptions, 'maxFailures' | 'windowMs' | 'now'>;
  /** The core behind the web API; without it only `/health` is served. */
  core?: Core;
  /** Checks Google ID tokens; without it `POST /api/auth/google` answers 503. */
  googleVerifier?: GoogleTokenVerifier;
  /** Names this server's WebSocket connections in the database. */
  serverId?: string;
  /** Seconds between WebSocket pings, in milliseconds. */
  wsPingIntervalMs?: number;
  /**
   * Checks that what the process depends on (the database) is reachable; rejects when it is not.
   * Without it `/health` only proves that the process is up.
   */
  healthCheck?: () => Promise<void>;
}

/**
 * Builds the HTTP server without starting it, so tests can drive it with `inject`.
 * Modules (web API, backoffice API, WebSocket) are registered here as they appear.
 */
export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const {
    config,
    core,
    googleVerifier,
    backoffice,
    backofficeAuth,
    healthCheck,
    serverId = 'server-1',
    wsPingIntervalMs = 30_000,
  } = options;
  const app = Fastify({ logger: { level: config.logLevel } });

  app.get('/health', async (request, reply) => {
    reply.type('text/plain');
    if (healthCheck) {
      try {
        await healthCheck();
      } catch (error) {
        request.log.error({ err: error }, 'health check failed');
        return reply.code(503).send('unavailable');
      }
    }
    return 'ok';
  });

  if (core) {
    await registerSessions(app, { core, secureCookies: config.nodeEnv === 'production' });
    registerAuthRoutes(app, {
      core,
      googleVerifier,
      // Double lock: the flag is honoured only in development, whatever the caller passed
      devLogin: config.devLogin === true && config.nodeEnv === 'development',
    });
    registerAdminAuth(app, {
      ...backofficeAuth,
      ...(backoffice && { credentials: backoffice }),
      secureCookies: config.nodeEnv === 'production',
    });
    registerAdminUsers(app, { core });
    registerStateRoutes(app, { core });
    registerActionRoutes(app, { core });
    registerHistoryRoutes(app, { core });
    await registerWebSocket(app, { core, serverId, pingIntervalMs: wsPingIntervalMs });
  }

  return app;
}
