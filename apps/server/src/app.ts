import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config';

export interface AppOptions {
  config: Pick<Config, 'logLevel'>;
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
export function buildApp(options: AppOptions): FastifyInstance {
  const { config, healthCheck } = options;
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

  return app;
}
