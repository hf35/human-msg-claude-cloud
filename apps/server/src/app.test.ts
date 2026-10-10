import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppOptions } from './app';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const build = async (options: Partial<AppOptions> = {}) =>
  (app = await buildApp({ config: { logLevel: 'silent' }, ...options }));

describe('GET /health', () => {
  it('answers ok', async () => {
    const response = await (await build()).inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^text\/plain/);
    expect(response.body).toBe('ok');
  });

  it('answers ok when the dependency check passes', async () => {
    let checked = 0;
    const response = await (
      await build({
        healthCheck: async () => void checked++,
      })
    ).inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(checked).toBe(1);
  });

  it('answers 503 when the dependency check fails', async () => {
    const response = await (
      await build({
        healthCheck: async () => {
          throw new Error('database is down');
        },
      })
    ).inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(503);
    expect(response.body).toBe('unavailable');
  });

  it('does not leak the error text to the client', async () => {
    const response = await (
      await build({
        healthCheck: async () => {
          throw new Error('password authentication failed for user "secret"');
        },
      })
    ).inject({ method: 'GET', url: '/health' });
    expect(response.body).not.toContain('secret');
  });
});

describe('unknown routes', () => {
  it('answer 404', async () => {
    const response = await (await build()).inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
  });
});

describe('shutdown', () => {
  it('close() stops the server', async () => {
    const server = await build();
    await server.listen({ host: '127.0.0.1', port: 0 });
    await server.close();
    expect(server.server.listening).toBe(false);
  });
});

describe('client address behind a reverse proxy', () => {
  const clientIp = async (trustProxy: boolean) => {
    const server = await build({ config: { logLevel: 'silent', trustProxy } });
    server.get('/ip', async (request) => request.ip);
    const response = await server.inject({
      method: 'GET',
      url: '/ip',
      remoteAddress: '172.18.0.2',
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });
    return response.body;
  };

  it('takes it from X-Forwarded-For when the proxy is trusted', async () => {
    expect(await clientIp(true)).toBe('203.0.113.7');
  });

  it('ignores the header otherwise, so a client cannot forge its address', async () => {
    expect(await clientIp(false)).toBe('172.18.0.2');
  });
});
