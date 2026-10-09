import { createManualTime } from '@human-msg/db';
import { createTestDatabase, type TestDatabase } from '@human-msg/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWebHarness } from '../web/testing';
import { ADMIN_COOKIE } from './auth';
import { hashPassword, isPasswordHash, verifyPassword } from './password';

let testDb: TestDatabase;
beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(() => testDb.close());

describe('password hash', () => {
  it('accepts the right password and refuses others', async () => {
    const hash = await hashPassword('correct horse');
    expect(isPasswordHash(hash)).toBe(true);
    expect(await verifyPassword('correct horse', hash)).toBe(true);
    expect(await verifyPassword('wrong horse', hash)).toBe(false);
  });

  it('salts: the same password gives different hashes', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  it('never matches a malformed hash', async () => {
    expect(await verifyPassword('x', 'plain-text')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$1$1$1$AAAA$AAAA')).toBe(false);
  });
});

const LOGIN = 'admin';
const PASSWORD = 'a long password';

async function setup(options: { maxFailures?: number; configured?: boolean } = {}) {
  let clock = 1_000_000;
  const harness = await createWebHarness(testDb, createManualTime(), {
    ...(options.configured !== false && {
      backoffice: { login: LOGIN, passwordHash: await hashPassword(PASSWORD) },
    }),
    backofficeAuth: { maxFailures: options.maxFailures ?? 3, windowMs: 60_000, now: () => clock },
  });
  const login = (login: string, password: string) =>
    harness.app.inject({ method: 'POST', url: '/admin/api/login', payload: { login, password } });
  return { ...harness, login, advance: (ms: number) => (clock += ms) };
}

const cookieOf = (response: { cookies: Array<{ name: string; value: string }> }) =>
  response.cookies.find((cookie) => cookie.name === ADMIN_COOKIE);

describe('POST /admin/api/login', () => {
  it('signs in with the right login and password', async () => {
    const { app, login } = await setup();
    const response = await login(LOGIN, PASSWORD);
    expect(response.statusCode).toBe(204);

    const cookie = cookieOf(response)!;
    expect(cookie).toMatchObject({ httpOnly: true, path: '/admin', sameSite: 'Strict' });

    const me = await app.inject({
      method: 'GET',
      url: '/admin/api/me',
      cookies: { [ADMIN_COOKIE]: cookie.value },
    });
    expect(me.statusCode).toBe(200);
  });

  it('refuses a wrong password and a wrong login the same way', async () => {
    const { login } = await setup();
    const badPassword = await login(LOGIN, 'nope');
    const badLogin = await login('root', PASSWORD);
    expect(badPassword.statusCode).toBe(401);
    expect(badLogin.statusCode).toBe(401);
    expect(badPassword.json()).toEqual(badLogin.json());
    expect(cookieOf(badPassword)).toBeUndefined();
  });

  it('refuses a malformed body', async () => {
    const { app } = await setup();
    const response = await app.inject({ method: 'POST', url: '/admin/api/login', payload: {} });
    expect(response.statusCode).toBe(400);
  });

  it('refuses further attempts after too many failures, even with the right password', async () => {
    const { login, advance } = await setup({ maxFailures: 3 });
    for (let i = 0; i < 3; i++) expect((await login(LOGIN, 'nope')).statusCode).toBe(401);

    const blocked = await login(LOGIN, PASSWORD);
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);

    // The window passes: the address may try again
    advance(61_000);
    expect((await login(LOGIN, PASSWORD)).statusCode).toBe(204);
  });

  it('a success clears the failures', async () => {
    const { login } = await setup({ maxFailures: 3 });
    await login(LOGIN, 'nope');
    await login(LOGIN, 'nope');
    expect((await login(LOGIN, PASSWORD)).statusCode).toBe(204);
    await login(LOGIN, 'nope');
    await login(LOGIN, 'nope');
    expect((await login(LOGIN, PASSWORD)).statusCode).toBe(204);
  });

  it('answers 503 when the back office is not configured', async () => {
    const { login, app } = await setup({ configured: false });
    expect((await login(LOGIN, PASSWORD)).statusCode).toBe(503);
    const me = await app.inject({ method: 'GET', url: '/admin/api/me' });
    expect(me.statusCode).toBe(503);
  });
});

describe('back office session', () => {
  it('is refused without a cookie, with a forged one and with a web session', async () => {
    const { app, signIn } = await setup();
    const get = (cookies: Record<string, string>) =>
      app.inject({ method: 'GET', url: '/admin/api/me', cookies });

    expect((await get({})).statusCode).toBe(401);
    expect((await get({ [ADMIN_COOKIE]: `${Date.now() + 1e9}.forged` })).statusCode).toBe(401);
    const { cookies } = await signIn();
    expect((await get(cookies)).statusCode).toBe(401);
  });

  it('expires', async () => {
    const { app, login, advance } = await setup();
    const cookie = cookieOf(await login(LOGIN, PASSWORD))!;
    const get = () =>
      app.inject({
        method: 'GET',
        url: '/admin/api/me',
        cookies: { [ADMIN_COOKIE]: cookie.value },
      });

    advance(11 * 60 * 60 * 1000);
    expect((await get()).statusCode).toBe(200);
    advance(2 * 60 * 60 * 1000);
    expect((await get()).statusCode).toBe(401);
  });

  it('does not open a web user session as admin and vice versa', async () => {
    const { app, login } = await setup();
    const cookie = cookieOf(await login(LOGIN, PASSWORD))!;
    const state = await app.inject({
      method: 'GET',
      url: '/api/me',
      cookies: { [ADMIN_COOKIE]: cookie.value },
    });
    expect(state.statusCode).toBe(401);
  });

  it('logout clears the cookie', async () => {
    const { app } = await setup();
    const response = await app.inject({ method: 'POST', url: '/admin/api/logout' });
    expect(response.statusCode).toBe(204);
    expect(cookieOf(response)).toMatchObject({ value: '', path: '/admin' });
  });
});
