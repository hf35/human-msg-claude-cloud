import { createHash, randomBytes } from 'node:crypto';
import { sessions, users, type User } from '@human-msg/db';
import { and, eq, gt, lt, sql } from 'drizzle-orm';
import type { Core } from './core';
import type { CommandContext } from './context';
import { fail, ok, type Result } from './result';

/** How long a web session lives. */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Expired sessions are deleted in batches of at most this many rows. */
const PURGE_BATCH_SIZE = 1000;

/** The database keeps only the hash, so a leaked table cannot be used to sign in. */
const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export interface IssuedSession {
  /** The secret to put into the cookie; it cannot be recovered later. */
  token: string;
  expiresAt: Date;
}

/** Starts a session of a web user. */
export async function createSession(
  ctx: CommandContext,
  userId: string,
  ttlSeconds = SESSION_TTL_SECONDS,
): Promise<Result<IssuedSession, never>> {
  const token = randomBytes(32).toString('base64url');
  const [row] = await ctx.tx
    .insert(sessions)
    .values({
      id: hashToken(token),
      userId,
      expiresAt: sql`${ctx.time.now()} + ${ttlSeconds} * interval '1 second'`,
    })
    .returning({ expiresAt: sessions.expiresAt });
  return ok({ token, expiresAt: row!.expiresAt });
}

/** Finds the user a session token belongs to; unknown and expired tokens are refused alike. */
export async function resolveSession(
  ctx: CommandContext,
  token: string,
): Promise<Result<User, 'no_session'>> {
  const [row] = await ctx.tx
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, hashToken(token)), gt(sessions.expiresAt, ctx.time.now())));
  return row ? ok(row.user) : fail('no_session');
}

/** Ends a session (logout). A token that is already gone is not an error. */
export async function deleteSession(
  ctx: CommandContext,
  token: string,
): Promise<Result<void, never>> {
  await ctx.tx.delete(sessions).where(eq(sessions.id, hashToken(token)));
  return ok();
}

/** Deletes expired sessions (one batch); returns how many were removed. */
export async function purgeExpiredSessions(core: Core): Promise<number> {
  const result = await core.run(async ({ tx, time }) => {
    const old = tx
      .select({ id: sessions.id })
      .from(sessions)
      .where(lt(sessions.expiresAt, time.now()))
      .limit(PURGE_BATCH_SIZE);
    const deleted = await tx
      .delete(sessions)
      .where(sql`${sessions.id} IN (${old})`)
      .returning({ id: sessions.id });
    return ok(deleted.length);
  });
  return result.ok ? result.value : 0;
}
