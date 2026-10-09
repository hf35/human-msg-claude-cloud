import { createTestDatabase, type TestDatabase } from '@human-msg/db/testing';
import { wsMessageSchema, type WsMessage } from '@human-msg/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { loadConfig } from '../config';
import { startServer, type RunningServer } from '../server';

let testDb: TestDatabase;
let running: RunningServer | undefined;
const clients: WebSocket[] = [];

beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(() => testDb.close());
beforeEach(() => testDb.reset());
afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate();
  await running?.stop();
  running = undefined;
});

/** The whole server as a browser sees it: HTTP with cookies and WebSocket, no mocks. */
async function start() {
  running = await startServer(
    loadConfig({
      DATABASE_URL: testDb.pool.options.connectionString!,
      NODE_ENV: 'development',
      DEV_LOGIN: 'true',
      LOG_LEVEL: 'silent',
      PORT: '0',
      // Slow timers: events must arrive because of NOTIFY, not because of polling
      WORKER_INTERVAL: '60',
      DISPATCH_INTERVAL: '60',
    }),
  );
  return running;
}

interface Person {
  cookie: string;
  messages: WsMessage[];
  post(path: string, body: unknown): Promise<Response>;
  get(path: string): Promise<Response>;
  waitFor(type: WsMessage['event']['type']): Promise<WsMessage>;
}

async function signIn(server: RunningServer, name: string, online = true): Promise<Person> {
  const base = server.address.replace('0.0.0.0', '127.0.0.1');
  const login = await fetch(`${base}/api/auth/dev`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  expect(login.status).toBe(200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const headers = { cookie, 'content-type': 'application/json' };

  const messages: WsMessage[] = [];
  if (online) {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/ws`, { headers: { cookie } });
    clients.push(ws);
    ws.on('message', (data) => messages.push(wsMessageSchema.parse(JSON.parse(String(data)))));
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
  }

  return {
    cookie,
    messages,
    post: (path, body) =>
      fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) }),
    get: (path) => fetch(`${base}${path}`, { headers }),
    async waitFor(type) {
      for (let i = 0; i < 300; i++) {
        const found = messages.find((message) => message.event.type === type);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`no ${type} event arrived; got ${messages.map((m) => m.event.type)}`);
    },
  };
}

// Waits until the server has recorded the connection, so the user can receive questions
const connected = async (count: number) => {
  for (let i = 0; i < 300; i++) {
    const { rows } = await testDb.pool.query(`SELECT 1 FROM web_connections`);
    if (rows.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('connections were not recorded');
};

describe('real-time delivery over WebSocket', () => {
  it('a question of one client reaches the other client, and the answer comes back', async () => {
    const server = await start();
    const bob = await signIn(server, 'bob');
    await connected(1);
    const alice = await signIn(server, 'alice');
    await connected(2);

    const asked = await alice.post('/api/messages', { text: 'What is your favourite colour?' });
    expect(asked.status).toBe(200);

    // Bob sees the question on his socket, with the author's alias only
    const assigned = await bob.waitFor('question.assigned');
    expect(assigned.event).toMatchObject({
      type: 'question.assigned',
      text: 'What is your favourite colour?',
    });
    const { alias } = (await alice.get('/api/me').then((r) => r.json())) as { alias: string };
    expect((assigned.event as { authorAlias: string }).authorAlias).toBe(alias);
    expect(JSON.stringify(assigned)).not.toContain('alice');
    // The question went to Bob, not back to its author
    expect(alice.messages.filter((m) => m.event.type === 'question.assigned')).toHaveLength(0);

    // Bob answers, and Alice gets the answer together with her question
    const answered = await bob.post('/api/messages', { text: 'Green, like a rabbit.' });
    expect(answered.status).toBe(200);
    const received = await alice.waitFor('answer.received');
    expect(received.event).toMatchObject({
      type: 'answer.received',
      questionText: 'What is your favourite colour?',
      answerText: 'Green, like a rabbit.',
    });
  });

  it('delivers an event to every open tab of the user', async () => {
    const server = await start();
    const bob = await signIn(server, 'bob');
    await connected(1);
    const second = await signIn(server, 'bob'); // the same account in another tab
    await connected(2);
    const alice = await signIn(server, 'alice');
    await connected(3);

    await alice.post('/api/messages', { text: 'Anybody there?' });
    await bob.waitFor('question.assigned');
    await second.waitFor('question.assigned');
  });

  it('tells a sender about a refusal', async () => {
    const server = await start();
    const alice = await signIn(server, 'alice');
    await connected(1);
    const response = await alice.post('/api/messages', { text: ' ' });
    expect(response.status).toBe(400);
    const event = await alice.waitFor('message.rejected');
    expect(event.event).toEqual({ type: 'message.rejected', reason: 'empty' });
  });

  it('does not fail for a user without an open socket', async () => {
    const server = await start();
    const alice = await signIn(server, 'alice', false);
    await alice.post('/api/messages', { text: 'Is anybody there?' });
    // The question is queued and the outbox event counts as delivered: the page reads /state later
    const state = (await alice.get('/api/state').then((r) => r.json())) as {
      pendingQuestion: { status: string };
    };
    expect(state.pendingQuestion).toMatchObject({ status: 'queued' });
    for (let i = 0; i < 100; i++) {
      const { rows } = await testDb.pool.query(`SELECT 1 FROM outbox WHERE delivered_at IS NULL`);
      if (rows.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('the event was not marked as delivered');
  });
});
