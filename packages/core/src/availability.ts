import { users, webConnections, type Tx } from '@human-msg/db';
import { eq } from 'drizzle-orm';
import type { CommandContext } from './context';
import { assignFromQueue } from './queue';
import { fail, ok, type Result } from './result';
import { userIsAvailable } from './user-available';

export { userIsAvailable } from './user-available';

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
  await assignFromQueue(ctx, userId);
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
  if (updated.length === 0) return fail('user_not_found');
  if (enabled) await assignFromQueue(ctx, userId);
  return ok();
}
