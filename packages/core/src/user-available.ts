import { sql, type SQL } from 'drizzle-orm';

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
