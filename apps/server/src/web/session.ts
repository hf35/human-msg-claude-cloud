import cookie from '@fastify/cookie';
import { createSession, deleteSession, resolveSession, type Core } from '@human-msg/core';
import type { User } from '@human-msg/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export const SESSION_COOKIE = 'session';

declare module 'fastify' {
  interface FastifyRequest {
    /** The signed-in web user; set by `requireUser`. */
    user: User | null;
  }
  interface FastifyInstance {
    sessions: SessionManager;
  }
}

export interface SessionOptions {
  core: Core;
  /** `Secure` cookies need HTTPS, so they are off in local development over plain HTTP. */
  secureCookies: boolean;
}

export interface SessionManager {
  /** Starts a session for the user and sets the cookie. */
  start(reply: FastifyReply, userId: string): Promise<void>;
  /** Ends the session of the request (if any) and clears the cookie. */
  end(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  /** `preHandler` for routes that need a signed-in user: answers 401 otherwise. */
  requireUser(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  /** Resolves the user of a request without answering; used by the WebSocket upgrade. */
  userOf(request: FastifyRequest): Promise<User | null>;
}

/**
 * Cookie sessions. The cookie holds a random token that is not signed: the database stores only
 * its hash, so it cannot be forged or guessed, and revoking it is deleting the row.
 */
export async function registerSessions(app: FastifyInstance, options: SessionOptions) {
  const { core, secureCookies } = options;
  await app.register(cookie);
  app.decorateRequest('user', null);

  const cookieOptions = {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: secureCookies,
  };

  const userOf = async (request: FastifyRequest): Promise<User | null> => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return null;
    const result = await core.run((ctx) => resolveSession(ctx, token));
    return result.ok ? result.value : null;
  };

  const manager: SessionManager = {
    async start(reply, userId) {
      const result = await core.run((ctx) => createSession(ctx, userId));
      if (!result.ok) throw new Error('session was not created');
      reply.setCookie(SESSION_COOKIE, result.value.token, {
        ...cookieOptions,
        expires: result.value.expiresAt,
      });
    },
    async end(request, reply) {
      const token = request.cookies[SESSION_COOKIE];
      if (token) await core.run((ctx) => deleteSession(ctx, token));
      reply.clearCookie(SESSION_COOKIE, cookieOptions);
    },
    async requireUser(request, reply) {
      const user = await userOf(request);
      if (!user) {
        // A stale cookie is dropped so the browser stops sending it
        if (request.cookies[SESSION_COOKIE]) reply.clearCookie(SESSION_COOKIE, cookieOptions);
        return reply.code(401).send({ error: 'unauthorized' });
      }
      request.user = user;
    },
    userOf,
  };
  app.decorate('sessions', manager);
}
