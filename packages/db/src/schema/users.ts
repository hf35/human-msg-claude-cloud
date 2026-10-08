import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const USER_CHANNELS = ['web', 'telegram'] as const;
export type UserChannel = (typeof USER_CHANNELS)[number];

export const USER_LOCALES = ['ru', 'en'] as const;
export type UserLocale = (typeof USER_LOCALES)[number];

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Web and Telegram accounts are separate users (see CLAUDE.md). Test and staff users have
 * neither a Google nor a Telegram identity: they are created from the back office.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channel: text('channel', { enum: USER_CHANNELS }).notNull(),
    googleSub: text('google_sub').unique(),
    // Telegram ids fit into 52 bits, so a JS number is safe
    telegramId: bigint('telegram_id', { mode: 'number' }).unique(),
    /** Anonymous pseudonym in the language chosen at registration; it never changes. */
    alias: text('alias').notNull().unique(),
    locale: text('locale', { enum: USER_LOCALES }).notNull().default('ru'),
    /** Test users live in their own pool and never meet real ones. */
    isTest: boolean('is_test').notNull().default(false),
    /** Staff users answer from the back office and never receive questions. */
    isStaff: boolean('is_staff').notNull().default(false),
    /** `false` is the "do not disturb" mode. */
    receivingEnabled: boolean('receiving_enabled').notNull().default(true),
    /** When Telegram reported that the user blocked the bot. */
    botBlockedAt: timestamptz('bot_blocked_at'),
    /** No new questions are assigned before this moment. */
    cooldownUntil: timestamptz('cooldown_until'),
    lastSeenAt: timestamptz('last_seen_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    check('users_channel_valid', sql`${table.channel} IN ('web', 'telegram')`),
    check('users_locale_valid', sql`${table.locale} IN ('ru', 'en')`),
    // A web user cannot have a Telegram id and vice versa
    check(
      'users_identity_matches_channel',
      sql`(${table.channel} = 'web' AND ${table.telegramId} IS NULL)
        OR (${table.channel} = 'telegram' AND ${table.googleSub} IS NULL)`,
    ),
    // Scanner that finds users whose cooldown has ended
    index('users_cooldown_until_idx').on(table.cooldownUntil),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
