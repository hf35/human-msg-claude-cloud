import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Open WebSocket connections. A web user is available while at least one row exists. A server
 * removes the rows with its own `server_id` on start, so crashes leave no stale rows.
 */
export const webConnections = pgTable(
  'web_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    serverId: text('server_id').notNull(),
    connectedAt: timestamp('connected_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('web_connections_user_idx').on(table.userId),
    index('web_connections_server_idx').on(table.serverId),
  ],
);

export type WebConnection = typeof webConnections.$inferSelect;
