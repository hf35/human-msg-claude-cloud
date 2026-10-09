import { getOrCreateUser } from '@human-msg/core';
import { devLoginRequestSchema, googleLoginRequestSchema } from '@human-msg/shared';
import type { Core } from '@human-msg/core';
import type { FastifyInstance } from 'fastify';
import type { GoogleTokenVerifier } from './google';

export interface AuthOptions {
  core: Core;
  /** Absent when Google sign-in is not configured. */
  googleVerifier?: GoogleTokenVerifier;
  /** Registers the sign-in without Google. The caller allows it only in development. */
  devLogin?: boolean;
}

/** Sign-in and sign-out routes; the session cookie itself is handled by `app.sessions`. */
export function registerAuthRoutes(app: FastifyInstance, options: AuthOptions): void {
  const { core, googleVerifier, devLogin = false } = options;

  /** Finds or registers the web user of a Google account and starts their session. */
  async function signIn(
    reply: Parameters<typeof app.sessions.start>[0],
    googleSub: string,
    locale?: 'ru' | 'en',
  ) {
    const result = await core.run(async ({ tx }) => ({
      ok: true as const,
      value: await getOrCreateUser(tx, { channel: 'web', googleSub, ...(locale && { locale }) }),
    }));
    if (!result.ok) throw new Error('unreachable');
    const { user } = result.value;
    await app.sessions.start(reply, user.id);
    return { alias: user.alias, locale: user.locale };
  }

  app.post('/api/auth/google', async (request, reply) => {
    if (!googleVerifier) return reply.code(503).send({ error: 'google_login_disabled' });
    const body = googleLoginRequestSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' });

    let sub: string;
    try {
      ({ sub } = await googleVerifier(body.data.idToken));
    } catch (error) {
      request.log.info({ err: error }, 'Google ID token rejected');
      return reply.code(401).send({ error: 'invalid_token' });
    }
    return signIn(reply, sub, body.data.locale);
  });

  app.post('/api/auth/logout', async (request, reply) => {
    await app.sessions.end(request, reply);
    return reply.code(204).send();
  });

  if (devLogin) {
    app.log.warn('dev login is enabled: anyone can sign in without Google');
    app.post('/api/auth/dev', async (request, reply) => {
      const body = devLoginRequestSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
      // Real Google ids are numeric, so the prefix keeps dev accounts apart from them
      return signIn(reply, `dev:${body.data.name.toLowerCase()}`, body.data.locale);
    });
  }
}
