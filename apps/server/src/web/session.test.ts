import { createCore, createSettingsStore } from '@human-msg/core';
import { createManualTime, sessions, users } from '@human-msg/db';
import { createTestDatabase, type TestDatabase } from '@human-msg/db/testing';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from './session';

let testDb: TestDatabase;
let app: FastifyInstance | undefined;
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
  await app?.close();
  app = undefined;
});

async function build(nodeEnv: 'development' | 'production' = 'development') {
  const settings = createSettingsStore({ db: testDb.db });
  const core = createCore({ db: testDb.db, settings, time });
  const built = (app = await buildApp({ config: { logLevel: 'silent', nodeEnv }, core }));
  // Throwaway routes that exercise the middleware
  built.post('/login/:id', async (request, reply) => {
    await built.sessions.start(reply, (request.params as { id: string }).id);
    return { ok: true };
  });
  built.post('/logout', async (request, reply) => {
    await built.sessions.end(request, reply);
    return { ok: true };
  });
  built.get('/whoami', { preHandler: built.sessions.requireUser }, async (request) => ({
    alias: request.user!.alias,
  }));
  return built;
}

async function createUser() {
  const [user] = await testDb.db
    .insert(users)
    .values({ alias: 'Green Rabbit', channel: 'web', googleSub: 'sub-1' })
    .returning();
  return user!;
}

const tokenOf = (response: LightMyRequestResponse) =>
  response.cookies.find((c) => c.name === SESSION_COOKIE)?.value;

async function signIn(server: FastifyInstance, userId: string) {
  const response = await server.inject({ method: 'POST', url: `/login/${userId}` });
  const token = tokenOf(response);
  expect(token).toBeTruthy();
  return { response, token: token! };
}

describe('session cookie', () => {
  it('is httpOnly, SameSite=Lax, scoped to the whole site and expires', async () => {
    const server = await build();
    const user = await createUser();
    const { response } = await signIn(server, user.id);
    const cookie = response.cookies.find((c) => c.name === SESSION_COOKIE)!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Lax');
    expect(cookie.path).toBe('/');
    expect(cookie.expires!.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 3600 * 1000);
    expect(cookie.secure).toBeUndefined();
  });

  it('is Secure in production', async () => {
    const server = await build('production');
    const user = await createUser();
    const { response } = await signIn(server, user.id);
    expect(response.cookies.find((c) => c.name === SESSION_COOKIE)!.secure).toBe(true);
  });

  it('is stored only as a hash', async () => {
    const server = await build();
    const user = await createUser();
    const { token } = await signIn(server, user.id);
    const rows = await testDb.db.select().from(sessions);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).not.toBe(token);
    expect(rows[0]!.userId).toBe(user.id);
    expect(rows[0]!.isAdmin).toBe(false);
  });
});

describe('requireUser', () => {
  it('lets a signed-in user through and exposes them as request.user', async () => {
    const server = await build();
    const user = await createUser();
    const { token } = await signIn(server, user.id);
    const response = await server.inject({
      method: 'GET',
      url: '/whoami',
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ alias: 'Green Rabbit' });
  });

  it('answers 401 without a cookie', async () => {
    const server = await build();
    const response = await server.inject({ method: 'GET', url: '/whoami' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized' });
  });

  it('answers 401 for an unknown token and clears the cookie', async () => {
    const server = await build();
    const response = await server.inject({
      method: 'GET',
      url: '/whoami',
      cookies: { [SESSION_COOKIE]: 'made-up' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.cookies.find((c) => c.name === SESSION_COOKIE)?.value).toBe('');
  });

  it('answers 401 once the session has expired', async () => {
    const server = await build();
    const user = await createUser();
    const { token } = await signIn(server, user.id);
    time.advance(31 * 24 * 3600 * 1000);
    const response = await server.inject({
      method: 'GET',
      url: '/whoami',
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(response.statusCode).toBe(401);
  });

  it('keeps sessions of different users apart', async () => {
    const server = await build();
    const first = await createUser();
    const [second] = await testDb.db
      .insert(users)
      .values({ alias: 'Blue Fox', channel: 'web', googleSub: 'sub-2' })
      .returning();
    const a = await signIn(server, first.id);
    const b = await signIn(server, second!.id);
    expect(a.token).not.toBe(b.token);
    const whoami = async (token: string) =>
      (
        await server.inject({
          method: 'GET',
          url: '/whoami',
          cookies: { [SESSION_COOKIE]: token },
        })
      ).json();
    expect(await whoami(a.token)).toEqual({ alias: 'Green Rabbit' });
    expect(await whoami(b.token)).toEqual({ alias: 'Blue Fox' });
  });
});

describe('ending a session', () => {
  it('logout removes the session and clears the cookie', async () => {
    const server = await build();
    const user = await createUser();
    const { token } = await signIn(server, user.id);
    const logout = await server.inject({
      method: 'POST',
      url: '/logout',
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(logout.cookies.find((c) => c.name === SESSION_COOKIE)?.value).toBe('');
    expect(await testDb.db.select().from(sessions)).toHaveLength(0);
    const after = await server.inject({
      method: 'GET',
      url: '/whoami',
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(after.statusCode).toBe(401);
  });

  it('logout without a session is harmless', async () => {
    const server = await build();
    const response = await server.inject({ method: 'POST', url: '/logout' });
    expect(response.statusCode).toBe(200);
  });
});
