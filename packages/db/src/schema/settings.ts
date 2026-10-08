import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Product settings edited in the back office (key → value). A missing row means "use the
 * default"; keys and value types are validated by `settingsSchema` in `@human-msg/shared`.
 */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export type SettingRow = typeof settings.$inferSelect;
