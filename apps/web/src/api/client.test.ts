import { describe, expect, it } from 'vitest';
import { ApiError, createApiClient } from './client';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function clientWith(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = createApiClient({
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return respond(String(url), init!);
    },
  });
  return { client, calls };
}

const me = {
  alias: 'Green Rabbit',
  locale: 'ru',
  awaitingAnswer: false,
  busy: false,
  cooldownUntil: null,
  questionLimit: { limit: 10, used: 0, remaining: 10 },
};

describe('api client', () => {
  it('reads and validates the profile', async () => {
    const { client, calls } = clientWith(() => json(me));
    expect(await client.me()).toEqual(me);
    expect(calls[0]).toMatchObject({ url: '/api/me', init: { method: 'GET' } });
  });

  it('sends the cookie with every request', async () => {
    const { client, calls } = clientWith(() => json(me));
    await client.me();
    expect(calls[0]!.init.credentials).toBe('same-origin');
  });

  it('posts JSON bodies', async () => {
    const { client, calls } = clientWith(() =>
      json({ kind: 'asked', questionId: 'q1', status: 'queued' }),
    );
    expect(await client.sendMessage('hello there')).toEqual({
      kind: 'asked',
      questionId: 'q1',
      status: 'queued',
    });
    expect(calls[0]!.url).toBe('/api/messages');
    expect(calls[0]!.init.body).toBe(JSON.stringify({ text: 'hello there' }));
    expect(calls[0]!.init.headers).toEqual({ 'content-type': 'application/json' });
  });

  it('turns a refusal into an ApiError with the reason code', async () => {
    const { client } = clientWith(() => json({ error: 'dailyLimit' }, 429));
    const error = await client.sendMessage('hello').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 429, code: 'dailyLimit' });
  });

  it('copes with a refusal that is not JSON', async () => {
    const { client } = clientWith(() => new Response('<html>bad gateway</html>', { status: 502 }));
    expect(await client.me().catch((e: unknown) => e)).toMatchObject({
      status: 502,
      code: 'unknown',
    });
  });

  it('reports an unreachable server as a network error', async () => {
    const client = createApiClient({
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    expect(await client.me().catch((e: unknown) => e)).toMatchObject({
      status: 0,
      code: 'network',
    });
  });

  it('refuses an answer that breaks the contract', async () => {
    const { client } = clientWith(() => json({ alias: 'Green Rabbit' }));
    await expect(client.me()).rejects.toThrow();
  });

  it('builds the history query', async () => {
    const { client, calls } = clientWith(() => json({ items: [], nextCursor: null }));
    await client.history();
    await client.history({ limit: 5, cursor: 'abc' });
    expect(calls.map((c) => c.url)).toEqual(['/api/history', '/api/history?limit=5&cursor=abc']);
  });

  it('logs out without reading a body', async () => {
    const { client, calls } = clientWith(() => new Response(null, { status: 204 }));
    expect(await client.logout()).toBeUndefined();
    expect(calls[0]).toMatchObject({ url: '/api/auth/logout', init: { method: 'POST' } });
  });
});
