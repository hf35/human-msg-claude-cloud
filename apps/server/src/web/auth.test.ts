import { createCore, createSettingsStore } from '@human-msg/core';
import { createManualTime, sessions, users } from '@human-msg/db';
import { createTestDatabase, type TestDatabase } from '@human-msg/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type AppOptions } from '../app';
import type { GoogleTokenVerifier } from './google';
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

// A stand-in for Google: the token "good-<sub>" is valid, anything else is rejected
const fakeVerifier: GoogleTokenVerifier = async (idToken) => {
  if (!idToken.startsWith('good-')) throw new Error('Wrong number of segments in token');
  return { sub: idToken.slice('good-'.length) };
};

async function build(config: Partial<AppOptions['config']> = {}, withGoogle = true) {
  const settings = createSettingsStore({ db: testDb.db });
  const core = createCore({ db: testDb.db, settings, time });
  const built = (app = await buildApp({
    config: { logLevel: 'silent', nodeEnv: 'development', devLogin: false, ...config },
    core,
    ...(withGoogle && { googleVerifier: fakeVerifier }),
  }));
  built.get('/whoami', { preHandler: built.sessions.requireUser }, async (request) => ({
    alias: request.user!.alias,
  }));
  return built;
}

const post = (server: FastifyInstance, url: string, payload?: unknown, token?: string) =>
  server.inject({
    method: 'POST',
    url,
    ...(payload !== undefined && { payload: payload as object }),
    ...(token && { cookies: { [SESSION_COOKIE]: token } }),
  });

const cookieOf = (response: Awaited<ReturnType<typeof post>>) =>
  response.cookies.find((c) => c.name === SESSION_COOKIE)?.value;

describe('POST /api/auth/google', () => {
  it('registers a new web user and starts a session', async () => {
    const server = await build();
    const response = await post(server, '/api/auth/google', {
      idToken: 'good-sub-1',
      locale: 'en',
    });
    expect(response.statusCode).toBe(200);
    const token = cookieOf(response);
    expect(token).toBeTruthy();

    const rows = await testDb.db.select().from(users);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: 'web', googleSub: 'sub-1', locale: 'en' });
    // The alias is in the language of the author
    expect(rows[0]!.alias).not.toMatch(/[а-яё]/i);
    expect(response.json()).toEqual({ alias: rows[0]!.alias, locale: 'en' });

    const whoami = await server.inject({
      method: 'GET',
      url: '/whoami',
      cookies: { [SESSION_COOKIE]: token! },
    });
    expect(whoami.json()).toEqual({ alias: rows[0]!.alias });
  });

  it('signs the same Google account in as the same user', async () => {
    const server = await build();
    await post(server, '/api/auth/google', { idToken: 'good-sub-1' });
    const again = await post(server, '/api/auth/google', { idToken: 'good-sub-1', locale: 'en' });
    expect(again.statusCode).toBe(200);
    const rows = await testDb.db.select().from(users);
    expect(rows).toHaveLength(1);
    // The language and alias chosen at registration stay
    expect(rows[0]!.locale).toBe('ru');
    expect(await testDb.db.select().from(sessions)).toHaveLength(2);
  });

  it('defaults to the Russian locale', async () => {
    const server = await build();
    await post(server, '/api/auth/google', { idToken: 'good-sub-1' });
    expect((await testDb.db.select().from(users))[0]!.locale).toBe('ru');
  });

  it('refuses a token that does not verify, without creating anything', async () => {
    const server = await build();
    const response = await post(server, '/api/auth/google', { idToken: 'forged' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'invalid_token' });
    expect(cookieOf(response)).toBeUndefined();
    expect(await testDb.db.select().from(users)).toHaveLength(0);
    expect(await testDb.db.select().from(sessions)).toHaveLength(0);
  });

  it('does not leak the verifier error to the client', async () => {
    const server = await build();
    const response = await post(server, '/api/auth/google', { idToken: 'forged' });
    expect(response.body).not.toContain('segments');
  });

  it.each([
    [undefined],
    [{}],
    [{ idToken: '' }],
    [{ idToken: 1 }],
    [{ idToken: 'x', locale: 'de' }],
  ])('answers 400 to the body %j', async (body) => {
    const server = await build();
    const response = await post(server, '/api/auth/google', body ?? {});
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_request' });
  });

  it('answers 503 when Google sign-in is not configured', async () => {
    const server = await build({}, false);
    const response = await post(server, '/api/auth/google', { idToken: 'good-sub-1' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'google_login_disabled' });
  });
});

describe('POST /api/auth/logout', () => {
  it('ends the session', async () => {
    const server = await build();
    const login = await post(server, '/api/auth/google', { idToken: 'good-sub-1' });
    const token = cookieOf(login)!;
    const response = await post(server, '/api/auth/logout', undefined, token);
    expect(response.statusCode).toBe(204);
    expect(await testDb.db.select().from(sessions)).toHaveLength(0);
    const whoami = await server.inject({
      method: 'GET',
      url: '/whoami',
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(whoami.statusCode).toBe(401);
  });

  it('is harmless without a session', async () => {
    const server = await build();
    expect((await post(server, '/api/auth/logout')).statusCode).toBe(204);
  });
});

describe('POST /api/auth/dev', () => {
  it('signs in without Google in development when the flag is on', async () => {
    const server = await build({ nodeEnv: 'development', devLogin: true });
    const response = await post(server, '/api/auth/dev', { name: 'Alice', locale: 'en' });
    expect(response.statusCode).toBe(200);
    expect(cookieOf(response)).toBeTruthy();
    const rows = await testDb.db.select().from(users);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: 'web', googleSub: 'dev:alice', locale: 'en' });

    // The same name is the same account
    await post(server, '/api/auth/dev', { name: 'ALICE' });
    expect(await testDb.db.select().from(users)).toHaveLength(1);
    await post(server, '/api/auth/dev', { name: 'Bob' });
    expect(await testDb.db.select().from(users)).toHaveLength(2);
  });

  it('does not exist when the flag is off', async () => {
    const server = await build({ nodeEnv: 'development', devLogin: false });
    expect((await post(server, '/api/auth/dev', { name: 'Alice' })).statusCode).toBe(404);
  });

  it.each(['production', 'test'] as const)(
    'is disabled in %s even if the flag is on',
    async (nodeEnv) => {
      const server = await build({ nodeEnv, devLogin: true });
      const response = await post(server, '/api/auth/dev', { name: 'Alice' });
      expect(response.statusCode).toBe(404);
      expect(cookieOf(response)).toBeUndefined();
      expect(await testDb.db.select().from(users)).toHaveLength(0);
    },
  );

  it.each([[{}], [{ name: '' }], [{ name: 'a/b' }], [{ name: 'x'.repeat(65) }]])(
    'answers 400 to the body %j',
    async (body) => {
      const server = await build({ nodeEnv: 'development', devLogin: true });
      expect((await post(server, '/api/auth/dev', body)).statusCode).toBe(400);
    },
  );
});
