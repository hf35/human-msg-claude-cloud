import { users, webConnections, type Tx } from '@human-msg/db';
import { eq, sql, type SQL } from 'drizzle-orm';
import type { CommandContext } from './context';
import { fail, ok, type Result } from './result';

// Column names are written out in full: Drizzle drops the table prefix of columns in a
// single-table query, which would make the subquery compare web_connections with itself.
/**
 * SQL condition "the user can receive a question right now", for the `users` table. The single
 * definition of availability (CLAUDE.md, "Термины"), shared by `isAvailable` and by the query
 * that picks a receiver:
 * - web: at least one open WebSocket connection;
 * - Telegram: "do not disturb" is off and the bot is not blocked. Activity does not matter.
 */
export const userIsAvailable: SQL<boolean> = sql<boolean>`(CASE WHEN "users"."channel" = 'web'
  THEN EXISTS (SELECT 1 FROM "web_connections" WHERE "web_connections"."user_id" = "users"."id")
  ELSE "users"."receiving_enabled" AND "users"."bot_blocked_at" IS NULL END)`;

/** Whether the user is available; `false` for an unknown user. */
export async function isAvailable(tx: Tx, userId: string): Promise<boolean> {
  const rows = await tx
    .select({ available: userIsAvailable })
    .from(users)
    .where(eq(users.id, userId));
  return rows[0]?.available === true;
}

/** Registers an open WebSocket connection; the user becomes available (web users only). */
export async function connect(
  ctx: CommandContext,
  userId: string,
  serverId: string,
  connectionId?: string,
): Promise<Result<{ connectionId: string }, 'user_not_found' | 'not_a_web_user'>> {
  const [user] = await ctx.tx.select().from(users).where(eq(users.id, userId));
  if (!user) return fail('user_not_found');
  if (user.channel !== 'web') return fail('not_a_web_user');
  const [row] = await ctx.tx
    .insert(webConnections)
    .values({ id: connectionId, userId, serverId })
    .returning({ id: webConnections.id });
  // Assigning a question from the queue to the newly available user is added with the queue
  return ok({ connectionId: row!.id });
}

/** Removes a closed connection. Closing an unknown connection is not an error (it may have been cleaned up). */
export async function disconnect(
  ctx: CommandContext,
  connectionId: string,
): Promise<Result<void, never>> {
  await ctx.tx.delete(webConnections).where(eq(webConnections.id, connectionId));
  return ok();
}

/** On server start: the connections it had before a crash or restart are gone. */
export async function clearServerConnections(
  ctx: CommandContext,
  serverId: string,
): Promise<Result<void, never>> {
  await ctx.tx.delete(webConnections).where(eq(webConnections.serverId, serverId));
  return ok();
}

/** "Do not disturb" off (`true`) or on (`false`). Affects Telegram availability only. */
export async function setReceiving(
  ctx: CommandContext,
  userId: string,
  enabled: boolean,
): Promise<Result<void, 'user_not_found'>> {
  const updated = await ctx.tx
    .update(users)
    .set({ receivingEnabled: enabled })
    .where(eq(users.id, userId))
    .returning({ id: users.id });
  return updated.length === 0 ? fail('user_not_found') : ok();
}
