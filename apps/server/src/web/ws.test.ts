import { isAvailable } from '@human-msg/core';
import { createManualTime } from '@human-msg/db';
import { createTestDatabase, type TestDatabase } from '@human-msg/db/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { SESSION_COOKIE } from './session';
import { createWebHarness, type WebHarness } from './testing';

let testDb: TestDatabase;
let web: WebHarness | undefined;
const sockets: WebSocket[] = [];
const time = createManualTime();

beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(() => testDb.close());
beforeEach(async () => {
  time.reset();
  await testDb.reset();
});
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await web?.app.close();
  web = undefined;
});

const harness = async (wsPingIntervalMs?: number) => {
  web = await createWebHarness(testDb, time, {
    serverId: 'test-server',
    ...(wsPingIntervalMs && { wsPingIntervalMs }),
  });
  await web.app.listen({ host: '127.0.0.1', port: 0 });
  return web;
};

/** Connects a real client to the listening server with the session cookie. */
const open = async (
  h: WebHarness,
  cookies?: Record<string, string>,
  onInit?: (ws: WebSocket) => void,
) => {
  const address = h.app.server.address();
  if (!address || typeof address === 'string') throw new Error('server is not listening');
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/ws`, {
    headers: cookies ? { cookie: `${SESSION_COOKIE}=${cookies[SESSION_COOKIE]}` } : {},
  });
  onInit?.(ws);
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('unexpected-response', (_request, response) =>
      reject(new Error(`Unexpected server response: ${response.statusCode}`)),
    );
    ws.once('error', reject);
  });
  return ws;
};

const eventually = async (check: () => Promise<boolean> | boolean, what: string) => {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for: ${what}`);
};

const rows = async () =>
  (await testDb.pool.query<{ user_id: string; server_id: string }>(`SELECT * FROM web_connections`))
    .rows;
const available = (h: WebHarness, userId: string) =>
  h.core.run(async (ctx) => ({ ok: true as const, value: await isAvailable(ctx.tx, userId) }));
const closed = (ws: WebSocket) => new Promise<void>((resolve) => ws.once('close', () => resolve()));

describe('GET /api/ws', () => {
  it('refuses a connection without a session', async () => {
    const h = await harness();
    await expect(open(h)).rejects.toThrow(/401/);
    expect(await rows()).toHaveLength(0);
  });

  it('refuses a connection with an unknown session', async () => {
    const h = await harness();
    await expect(open(h, { [SESSION_COOKIE]: 'made-up' })).rejects.toThrow(/401/);
  });

  it('makes the user available while the connection is open', async () => {
    const h = await harness();
    const { user, cookies } = await h.signIn();
    expect(await available(h, user.id)).toEqual({ ok: true, value: false });

    const ws = await open(h, cookies);
    await eventually(async () => (await rows()).length === 1, 'connection recorded');
    expect(await rows()).toMatchObject([{ user_id: user.id, server_id: 'test-server' }]);
    expect(await available(h, user.id)).toEqual({ ok: true, value: true });

    const gone = closed(ws);
    ws.close();
    await gone;
    await eventually(async () => (await rows()).length === 0, 'connection removed');
    expect(await available(h, user.id)).toEqual({ ok: true, value: false });
  });

  it('keeps the user available while another tab is open', async () => {
    const h = await harness();
    const { user, cookies } = await h.signIn();
    const first = await open(h, cookies);
    await open(h, cookies);
    await eventually(async () => (await rows()).length === 2, 'both recorded');
    expect(h.app.connections.sockets(user.id)).toHaveLength(2);

    const gone = closed(first);
    first.close();
    await gone;
    await eventually(async () => (await rows()).length === 1, 'one removed');
    expect(await available(h, user.id)).toEqual({ ok: true, value: true });
    expect(h.app.connections.sockets(user.id)).toHaveLength(1);
  });

  it('hands out a waiting question on connect', async () => {
    const h = await harness();
    const author = await h.signIn();
    const receiver = await h.signIn();
    await h.app.inject({
      method: 'POST',
      url: '/api/messages',
      payload: { text: 'Waiting for you' },
      cookies: author.cookies,
    });

    await open(h, receiver.cookies);
    await eventually(async () => {
      const state = (
        await h.app.inject({ method: 'GET', url: '/api/state', cookies: receiver.cookies })
      ).json();
      return state.assignment?.text === 'Waiting for you';
    }, 'question assigned');
  });

  it('ignores what the client sends', async () => {
    const h = await harness();
    const { cookies } = await h.signIn();
    const ws = await open(h, cookies);
    ws.send('hello');
    ws.send(JSON.stringify({ type: 'anything' }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ws.readyState).toBe(ws.OPEN);
  });
});

describe('ping/pong', () => {
  it('closes a connection that stops answering pings and frees the user', async () => {
    const h = await harness(30);
    const { user, cookies } = await h.signIn();
    // A client that never answers pings, like a dead network path
    const ws = await open(h, cookies, (socket) => {
      socket.pong = () => {};
    });
    await eventually(async () => (await rows()).length === 1, 'connection recorded');

    await closed(ws);
    await eventually(async () => (await rows()).length === 0, 'connection removed');
    expect(await available(h, user.id)).toEqual({ ok: true, value: false });
  });

  it('keeps a connection that answers pings', async () => {
    const h = await harness(30);
    const { cookies } = await h.signIn();
    const ws = await open(h, cookies);
    let pings = 0;
    ws.on('ping', () => pings++);
    await eventually(() => pings >= 4, 'several pings');
    expect(ws.readyState).toBe(ws.OPEN);
    expect(await rows()).toHaveLength(1);
  });
});

describe('shutdown', () => {
  it('closes the sockets and removes their rows before returning', async () => {
    const h = await harness();
    const { cookies } = await h.signIn();
    const ws = await open(h, cookies);
    await eventually(async () => (await rows()).length === 1, 'connection recorded');

    await h.app.close();
    expect(ws.readyState).not.toBe(ws.OPEN);
    expect(await rows()).toHaveLength(0);
  });
});
