import { createManualTime, users, type NewUser, type User } from '@human-msg/db';
import type { LightMyRequestResponse } from 'fastify';
import type { TestDatabase } from '@human-msg/db/testing';
import { createWebHarness, type WebHarness } from '../web/testing';
import { ADMIN_COOKIE } from './auth';
import { hashPassword } from './password';

/** Helpers for tests of the back office API; imported by tests only. */
export interface AdminHarness extends WebHarness {
  time: ReturnType<typeof createManualTime>;
  /** The cookie of a signed-in back office session. */
  cookies: Record<string, string>;
  /** Inserts a user straight into the database. */
  createUser(values?: Partial<NewUser>): Promise<User>;
  get(url: string): Promise<LightMyRequestResponse>;
  send(
    method: 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: object,
  ): Promise<LightMyRequestResponse>;
}

export async function createAdminHarness(testDb: TestDatabase): Promise<AdminHarness> {
  const time = createManualTime();
  const harness = await createWebHarness(testDb, time, {
    backoffice: { login: 'admin', passwordHash: await hashPassword('test password') },
  });
  const login = await harness.app.inject({
    method: 'POST',
    url: '/admin/api/login',
    payload: { login: 'admin', password: 'test password' },
  });
  const cookies = { [ADMIN_COOKIE]: login.cookies.find((c) => c.name === ADMIN_COOKIE)!.value };

  let counter = 0;
  return {
    ...harness,
    time,
    cookies,
    async createUser(values = {}) {
      counter++;
      const [user] = await testDb.db
        .insert(users)
        .values({
          alias: `Admin Test ${counter}`,
          channel: 'telegram',
          telegramId: 70_000 + counter,
          ...values,
        })
        .returning();
      return user!;
    },
    get: (url) => harness.app.inject({ method: 'GET', url, cookies }),
    send: (method, url, payload) => harness.app.inject({ method, url, cookies, payload }),
  };
}
