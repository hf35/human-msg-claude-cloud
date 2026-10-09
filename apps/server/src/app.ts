import Fastify, { type FastifyInstance } from 'fastify';
import type { Core } from '@human-msg/core';
import type { Config } from './config';
import { registerSessions } from './web/session';

export interface AppOptions {
  config: Pick<Config, 'logLevel'> & Partial<Pick<Config, 'nodeEnv'>>;
  /** The core behind the web API; without it only `/health` is served. */
  core?: Core;
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
  const { config, core, healthCheck } = options;
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
  }

  return app;
}
