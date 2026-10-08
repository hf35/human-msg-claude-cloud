import { users, type Tx, type User } from '@human-msg/db';
import { DEFAULT_LOCALE, randomAlias, type Locale, type RandomSource } from '@human-msg/shared';
import { eq, or, sql } from 'drizzle-orm';

/** Fresh random aliases tried before falling back to a numbered one ("Green Rabbit 2"). */
const RANDOM_ALIAS_ATTEMPTS = 5;
/** Rounds of "pick an alias, insert" before giving up under heavy contention. */
const MAX_INSERT_ROUNDS = 50;

interface Options {
  /** Injectable for deterministic tests. */
  random?: RandomSource;
}

interface Identity {
  locale?: Locale;
}

/** A person who signed in with Google (web) or wrote to the bot (Telegram). */
export type RegisterUserInput =
  | ({ channel: 'web'; googleSub: string } & Identity)
  | ({ channel: 'telegram'; telegramId: number } & Identity);

/** Test and staff users have no Google or Telegram identity: the back office creates them. */
export interface InternalUserInput extends Identity {
  channel?: 'web' | 'telegram';
}

export const findUserByGoogleSub = async (tx: Tx, googleSub: string): Promise<User | undefined> =>
  (await tx.select().from(users).where(eq(users.googleSub, googleSub)))[0];

export const findUserByTelegramId = async (tx: Tx, telegramId: number): Promise<User | undefined> =>
  (await tx.select().from(users).where(eq(users.telegramId, telegramId)))[0];

/** Postgres error details behind a Drizzle error, if any. */
function pgError(error: unknown): { code?: string; constraint?: string } {
  const cause = (error as { cause?: unknown }).cause;
  return typeof cause === 'object' && cause !== null ? cause : {};
}

/**
 * Picks an alias nobody has yet (best effort: a parallel registration may take it first, which
 * the unique index catches and the caller retries).
 */
async function pickFreeAlias(tx: Tx, locale: Locale, random: RandomSource): Promise<string> {
  let base = randomAlias(locale, random);
  for (let attempt = 0; attempt < RANDOM_ALIAS_ATTEMPTS; attempt++) {
    const taken = await tx.select({ id: users.id }).from(users).where(eq(users.alias, base));
    if (taken.length === 0) return base;
    if (attempt < RANDOM_ALIAS_ATTEMPTS - 1) base = randomAlias(locale, random);
  }

  // Every combination tried was taken: number the last one, "Green Rabbit 2", "Green Rabbit 3", ...
  const rows = await tx
    .select({ alias: users.alias })
    .from(users)
    .where(
      or(
        eq(users.alias, base),
        sql`${users.alias} LIKE ${`${base.replaceAll(/[\\%_]/g, '\\$&')} %`}`,
      ),
    );
  const used = new Set(rows.map((row) => row.alias));
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * Inserts a user with a unique alias. A parallel registration may take the alias between the
 * check and the insert; the unique index rejects the insert and the alias is chosen again.
 * Returns `undefined` if the insert was rejected because of the identity (google_sub or
 * telegram_id), i.e. the same person registered in parallel.
 */
async function insertWithAlias(
  tx: Tx,
  values: Omit<typeof users.$inferInsert, 'alias'>,
  random: RandomSource,
): Promise<User | undefined> {
  const locale = values.locale ?? DEFAULT_LOCALE;
  for (let round = 0; round < MAX_INSERT_ROUNDS; round++) {
    const alias = await pickFreeAlias(tx, locale, random);
    try {
      // A savepoint: a failed insert must not abort the surrounding command transaction
      return await tx.transaction(async (inner) => {
        const [created] = await inner
          .insert(users)
          .values({ ...values, alias })
          .returning();
        return created!;
      });
    } catch (error) {
      const { code, constraint } = pgError(error);
      if (code !== '23505') throw error;
      if (constraint !== 'users_alias_unique') return undefined;
    }
  }
  throw new Error('Could not find a free alias');
}

/**
 * Finds the user with this Google or Telegram identity or registers a new one with a unique
 * anonymous alias in the user's language. The alias never changes afterwards.
 */
export async function getOrCreateUser(
  tx: Tx,
  input: RegisterUserInput,
  { random = Math.random }: Options = {},
): Promise<{ user: User; created: boolean }> {
  const find = () =>
    input.channel === 'web'
      ? findUserByGoogleSub(tx, input.googleSub)
      : findUserByTelegramId(tx, input.telegramId);

  const existing = await find();
  if (existing) return { user: existing, created: false };

  const identity =
    input.channel === 'web' ? { googleSub: input.googleSub } : { telegramId: input.telegramId };
  const created = await insertWithAlias(
    tx,
    { channel: input.channel, locale: input.locale ?? DEFAULT_LOCALE, ...identity },
    random,
  );
  if (created) return { user: created, created: true };

  // The same person was registered by a parallel request
  const winner = await find();
  if (!winner) throw new Error('User registration conflicted but no user was found');
  return { user: winner, created: false };
}

async function createInternalUser(
  tx: Tx,
  flags: { isTest?: boolean; isStaff?: boolean },
  { channel = 'web', locale = DEFAULT_LOCALE }: InternalUserInput,
  random: RandomSource,
): Promise<User> {
  const created = await insertWithAlias(tx, { channel, locale, ...flags }, random);
  // Without an identity there is nothing else that could conflict
  if (!created) throw new Error('Could not create the user');
  return created;
}

/** A test user lives in its own pool and never meets real users. */
export const createTestUser = (
  tx: Tx,
  input: InternalUserInput = {},
  { random = Math.random }: Options = {},
) => createInternalUser(tx, { isTest: true }, input, random);

/** A staff user answers from the back office and never receives questions. */
export const createStaffUser = (
  tx: Tx,
  input: InternalUserInput = {},
  { random = Math.random }: Options = {},
) => createInternalUser(tx, { isStaff: true }, input, random);
