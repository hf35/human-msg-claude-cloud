import { users } from '@human-msg/db';
import type { Locale } from '@human-msg/shared';
import { eq } from 'drizzle-orm';
import { setReceiving } from './availability';
import type { CommandContext } from './context';
import { handleIncomingText, type IncomingOutcome } from './incoming';
import { skipAssignment } from './questions';
import { fail, type Result } from './result';
import { getUserState, type UserState } from './state';
import { createTestUser } from './users';

/**
 * Test users let the back office play several people (CLAUDE.md, "Бэкофис"). They live in their
 * own pool, so they never get real users' questions and real users never get theirs.
 *
 * Every action here first checks that the user is a test user: the back office must never send
 * or skip anything in the name of a real person.
 */
async function requireTestUser(
  ctx: CommandContext,
  userId: string,
): Promise<Result<void, 'not_found' | 'not_test_user'>> {
  const [user] = await ctx.tx
    .select({ isTest: users.isTest })
    .from(users)
    .where(eq(users.id, userId))
    .for('no key update');
  if (!user) return fail('not_found');
  if (!user.isTest) return fail('not_test_user');
  return { ok: true, value: undefined };
}

/**
 * Creates a test user with a random alias. They are Telegram-like: with no connection to track,
 * "available" is simply the "receiving" flag, which the back office switches
 * (`setTestUserReceiving`). New test users start with it off, so nothing reaches them until the
 * operator wants it.
 */
export async function createTestAccount(
  ctx: CommandContext,
  locale: Locale = 'ru',
): Promise<Result<{ id: string }, never>> {
  const user = await createTestUser(ctx.tx, { channel: 'telegram', locale });
  await ctx.tx.update(users).set({ receivingEnabled: false }).where(eq(users.id, user.id));
  return { ok: true, value: { id: user.id } };
}

/** Turns the availability of a test user on or off. Turning it on hands them a queued question. */
export async function setTestUserReceiving(
  ctx: CommandContext,
  userId: string,
  enabled: boolean,
): Promise<Result<void, 'not_found' | 'not_test_user'>> {
  const guard = await requireTestUser(ctx, userId);
  if (!guard.ok) return guard;
  return setReceiving(ctx, userId, enabled) as Promise<Result<void, 'not_found'>>;
}

/** A text from a test user: an answer if they have a question assigned, else a new question. */
export async function sendAsTestUser(
  ctx: CommandContext,
  userId: string,
  text: string,
): Promise<
  Result<
    IncomingOutcome,
    | 'not_found'
    | 'not_test_user'
    | Extract<Awaited<ReturnType<typeof handleIncomingText>>, { ok: false }>['reason']
  >
> {
  const guard = await requireTestUser(ctx, userId);
  if (!guard.ok) return guard;
  return handleIncomingText(ctx, userId, text);
}

/** A test user skips the question assigned to them. */
export async function skipAsTestUser(
  ctx: CommandContext,
  userId: string,
): Promise<Result<{ questionId: string }, 'not_found' | 'not_test_user' | 'no_active_assignment'>> {
  const guard = await requireTestUser(ctx, userId);
  if (!guard.ok) return guard;
  return skipAssignment(ctx, userId);
}

/** What a test user sees: the question assigned to them, their own pending question. */
export async function getTestUserState(
  ctx: CommandContext,
  userId: string,
): Promise<Result<UserState, 'not_found' | 'not_test_user'>> {
  const guard = await requireTestUser(ctx, userId);
  if (!guard.ok) return guard;
  const state = await getUserState(ctx, userId);
  return state.ok ? state : fail('not_found');
}
