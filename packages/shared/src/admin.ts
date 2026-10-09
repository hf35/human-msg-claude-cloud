import { z } from 'zod';

const isoTime = z.iso.datetime();
const flag = z.enum(['true', 'false']).transform((value) => value === 'true');

/** `GET /admin/api/users` query. */
export const adminUsersQuerySchema = z.object({
  channel: z.enum(['web', 'telegram']).optional(),
  isTest: flag.optional(),
  isStaff: flag.optional(),
  /** Registered at or after this moment. */
  createdFrom: isoTime.optional(),
  /** Registered before this moment. */
  createdTo: isoTime.optional(),
  /** Part of the alias. */
  search: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
export type AdminUsersQuery = z.infer<typeof adminUsersQuerySchema>;

/** A user in the back office. Real identities are shown here, never to other users. */
export const adminUserSchema = z.object({
  id: z.string(),
  channel: z.enum(['web', 'telegram']),
  alias: z.string(),
  locale: z.enum(['ru', 'en']),
  telegramId: z.number().nullable(),
  isTest: z.boolean(),
  isStaff: z.boolean(),
  receivingEnabled: z.boolean(),
  missedDeadlines: z.number().int(),
  botBlockedAt: isoTime.nullable(),
  cooldownUntil: isoTime.nullable(),
  lastSeenAt: isoTime.nullable(),
  createdAt: isoTime,
  questionsAsked: z.number().int(),
  answersGiven: z.number().int(),
});
export type AdminUserDto = z.infer<typeof adminUserSchema>;

/** `GET /admin/api/users`. */
export const adminUsersResponseSchema = z.object({
  items: z.array(adminUserSchema),
  total: z.number().int(),
});
export type AdminUsersResponse = z.infer<typeof adminUsersResponseSchema>;
