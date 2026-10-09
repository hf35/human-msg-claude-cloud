import {
  createCore,
  createSession,
  createSettingsStore,
  type Core,
  type SettingsStore,
} from '@human-msg/core';
import { users, type ManualTime, type User } from '@human-msg/db';
import type { TestDatabase } from '@human-msg/db/testing';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { SESSION_COOKIE } from './session';

/** Helpers for tests of the web API; imported by tests only. */
export interface WebHarness {
  app: FastifyInstance;
  core: Core;
  settings: SettingsStore;
  /** Creates a web user and a session for them; returns the user and the cookie to send. */
  signIn(alias?: string): Promise<{ user: User; cookies: Record<string, string> }>;
}

export async function createWebHarness(
  testDb: TestDatabase,
  time: ManualTime,
  appOptions: Partial<Parameters<typeof buildApp>[0]> = {},
): Promise<WebHarness> {
  const settings = createSettingsStore({ db: testDb.db });
  const core = createCore({ db: testDb.db, settings, time });
  const app = await buildApp({
    config: { logLevel: 'silent', nodeEnv: 'test', devLogin: false },
    core,
    settings,
    ...appOptions,
  });
  // Plugins finish loading here; the WebSocket upgrade handler is attached on ready
  await app.ready();

  let counter = 0;
  return {
    app,
    core,
    settings,
    async signIn(alias) {
      counter++;
      const [user] = await testDb.db
        .insert(users)
        .values({
          alias: alias ?? `Web User ${counter}`,
          channel: 'web',
          googleSub: `harness-${counter}-${Math.random()}`,
        })
        .returning();
      const created = await core.run((ctx) => createSession(ctx, user!.id));
      if (!created.ok) throw new Error('unreachable');
      return { user: user!, cookies: { [SESSION_COOKIE]: created.value.token } };
    },
  };
}
