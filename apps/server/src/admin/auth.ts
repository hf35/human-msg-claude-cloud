import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { verifyPassword } from './password';
import { AttemptLimiter } from './rate-limit';

export const ADMIN_COOKIE = 'backoffice_session';
/** Everything of the back office API lives under this path; the cookie is sent nowhere else. */
export const ADMIN_PATH = '/admin';
const SESSION_MS = 12 * 60 * 60 * 1000;

declare module 'fastify' {
  interface FastifyInstance {
    admin: AdminAuth;
  }
}

export interface AdminAuth {
  /** `preHandler` for back office routes: answers 401 without a valid back office session. */
  require(request: FastifyRequest, reply: FastifyReply): Promise<void>;
}

export interface AdminAuthOptions {
  /** Absent when the back office is not configured: every route answers 503. */
  credentials?: { login: string; passwordHash: string };
  secureCookies: boolean;
  /** Failed sign-ins allowed per address per window. */
  maxFailures?: number;
  windowMs?: number;
  now?: () => number;
}

const loginSchema = z.object({ login: z.string().max(200), password: z.string().max(1000) });

/**
 * Sign-in of the back office: one login and password hash from the environment. The session is a
 * signed expiry time in its own cookie, limited to `/admin`; nothing is stored. The signing key
 * is derived from the password hash, so changing the password ends every session.
 */
export function registerAdminAuth(app: FastifyInstance, options: AdminAuthOptions): void {
  const {
    credentials,
    secureCookies,
    maxFailures = 5,
    windowMs = 15 * 60 * 1000,
    now = Date.now,
  } = options;
  const limiter = new AttemptLimiter({ maxFailures, windowMs, now });
  const cookieOptions = {
    path: ADMIN_PATH,
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: secureCookies,
  };

  const sign = (expiresAt: number) =>
    createHmac('sha256', `backoffice:${credentials?.passwordHash ?? ''}`)
      .update(`${credentials?.login ?? ''}:${expiresAt}`)
      .digest('base64url');

  const issue = (): { token: string; expires: Date } => {
    const expiresAt = now() + SESSION_MS;
    return { token: `${expiresAt}.${sign(expiresAt)}`, expires: new Date(expiresAt) };
  };

  const valid = (token: string | undefined): boolean => {
    if (!credentials || !token) return false;
    const [expiresText, signature = ''] = token.split('.');
    const expiresAt = Number(expiresText);
    if (!Number.isFinite(expiresAt) || expiresAt <= now()) return false;
    const expected = Buffer.from(sign(expiresAt));
    const given = Buffer.from(signature);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  app.decorate('admin', {
    async require(request, reply) {
      if (!credentials) return reply.code(503).send({ error: 'backoffice_disabled' });
      if (!valid(request.cookies[ADMIN_COOKIE])) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
    },
  } satisfies AdminAuth);

  app.post(`${ADMIN_PATH}/api/login`, async (request, reply) => {
    if (!credentials) return reply.code(503).send({ error: 'backoffice_disabled' });
    const key = request.ip;
    const wait = limiter.retryAfterMs(key);
    if (wait > 0) {
      return reply
        .code(429)
        .header('retry-after', Math.ceil(wait / 1000))
        .send({ error: 'too_many_attempts' });
    }
    const body = loginSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' });

    // Both checks always run, so the time does not tell which of them was wrong
    const passwordOk = await verifyPassword(body.data.password, credentials.passwordHash);
    const loginOk = body.data.login === credentials.login;
    if (!passwordOk || !loginOk) {
      limiter.fail(key);
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    limiter.reset(key);
    const session = issue();
    reply.setCookie(ADMIN_COOKIE, session.token, { ...cookieOptions, expires: session.expires });
    return reply.code(204).send();
  });

  app.post(`${ADMIN_PATH}/api/logout`, async (_request, reply) => {
    reply.clearCookie(ADMIN_COOKIE, cookieOptions);
    return reply.code(204).send();
  });

  // Lets the back office page ask whether it is signed in
  app.get(`${ADMIN_PATH}/api/me`, { preHandler: app.admin.require }, async () => ({ ok: true }));
}
