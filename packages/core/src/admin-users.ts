import { users, type User } from '@human-msg/db';
import { and, desc, eq, gte, ilike, lt, sql, type SQL } from 'drizzle-orm';
import type { CommandContext } from './context';
import { fail, ok, type Result } from './result';

export const ADMIN_USERS_MAX_LIMIT = 100;

export interface UserFilter {
  channel?: 'web' | 'telegram';
  isTest?: boolean;
  isStaff?: boolean;
  /** Registered at or after this moment. */
  createdFrom?: Date;
  /** Registered before this moment. */
  createdTo?: Date;
  /** Part of the alias, any case. */
  search?: string;
}

/** A user as the back office sees them: with the counters of what they did. */
export interface AdminUser extends User {
  questionsAsked: number;
  answersGiven: number;
}

export interface AdminUserPage {
  items: AdminUser[];
  total: number;
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, '\\$&');

// Column names are written out in full: Drizzle drops the table prefix of columns in a
// single-table query, so `users.id` would be read as the id of the table inside the subquery.
const asked = sql<number>`(SELECT count(*)::int FROM "questions" WHERE "questions"."author_id" = "users"."id")`;
const given = sql<number>`(SELECT count(*)::int FROM "answers" WHERE "answers"."author_id" = "users"."id")`;

/** Back office: users, newest first, filtered and paged. */
export async function listUsers(
  { tx }: CommandContext,
  filter: UserFilter = {},
  options: { limit?: number; offset?: number } = {},
): Promise<Result<AdminUserPage, never>> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), ADMIN_USERS_MAX_LIMIT);
  const offset = Math.max(options.offset ?? 0, 0);
  const conditions: Array<SQL | undefined> = [
    filter.channel ? eq(users.channel, filter.channel) : undefined,
    filter.isTest !== undefined ? eq(users.isTest, filter.isTest) : undefined,
    filter.isStaff !== undefined ? eq(users.isStaff, filter.isStaff) : undefined,
    filter.createdFrom ? gte(users.createdAt, filter.createdFrom) : undefined,
    filter.createdTo ? lt(users.createdAt, filter.createdTo) : undefined,
    filter.search ? ilike(users.alias, `%${escapeLike(filter.search)}%`) : undefined,
  ];
  const where = and(...conditions);

  const rows = await tx
    .select({ user: users, questionsAsked: asked, answersGiven: given })
    .from(users)
    .where(where)
    .orderBy(desc(users.createdAt), desc(users.id))
    .limit(limit)
    .offset(offset);
  const [{ total } = { total: 0 }] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(users)
    .where(where);

  return ok({
    items: rows.map((row) => ({
      ...row.user,
      questionsAsked: row.questionsAsked,
      answersGiven: row.answersGiven,
    })),
    total,
  });
}

/** Back office: one user with their counters. */
export async function getAdminUser(
  { tx }: CommandContext,
  userId: string,
): Promise<Result<AdminUser, 'not_found'>> {
  const [row] = await tx
    .select({ user: users, questionsAsked: asked, answersGiven: given })
    .from(users)
    .where(eq(users.id, userId));
  if (!row) return fail('not_found');
  return ok({ ...row.user, questionsAsked: row.questionsAsked, answersGiven: row.answersGiven });
}
