import { z } from 'zod';
import type { Settings } from './settings';

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

/** `GET /admin/api/questions` query. */
export const adminQuestionsQuerySchema = z.object({
  status: z.enum(['queued', 'assigned', 'answered', 'expired']).optional(),
  /** Only the questions of this author. */
  authorId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
export type AdminQuestionsQuery = z.infer<typeof adminQuestionsQuerySchema>;

export const adminAssignmentSchema = z.object({
  receiverId: z.string(),
  receiverAlias: z.string(),
  assignedAt: isoTime,
  deadlineAt: isoTime,
  endedAt: isoTime.nullable(),
  /** `null` while the assignment is active. */
  outcome: z.enum(['answered', 'timed_out', 'skipped', 'reported', 'undeliverable']).nullable(),
});

/** A question with who asked, who got it and what came back. */
export const adminQuestionSchema = z.object({
  id: z.string(),
  text: z.string(),
  status: z.enum(['queued', 'assigned', 'answered', 'expired']),
  authorId: z.string(),
  authorAlias: z.string(),
  createdAt: isoTime,
  expiresAt: isoTime,
  answeredAt: isoTime.nullable(),
  answer: z
    .object({
      text: z.string(),
      responderId: z.string(),
      responderAlias: z.string(),
      createdAt: isoTime,
    })
    .nullable(),
  /** Oldest first. */
  assignments: z.array(adminAssignmentSchema),
});
export type AdminQuestionDto = z.infer<typeof adminQuestionSchema>;

/** `GET /admin/api/questions`: newest first. */
export const adminQuestionsResponseSchema = z.object({
  items: z.array(adminQuestionSchema),
  total: z.number().int(),
});
export type AdminQuestionsResponse = z.infer<typeof adminQuestionsResponseSchema>;

/** `POST /admin/api/questions/:id/staff-answer` body. */
export const staffAnswerRequestSchema = z.object({ text: z.string().max(20_000) });
export type StaffAnswerRequest = z.infer<typeof staffAnswerRequestSchema>;

/** `POST /admin/api/test-users` body. */
export const createTestUserRequestSchema = z.object({
  locale: z.enum(['ru', 'en']).default('ru'),
});

/** `PUT /admin/api/test-users/:id/receiving` body: the availability flag of a test user. */
export const testUserReceivingRequestSchema = z.object({ receivingEnabled: z.boolean() });

/** `POST /admin/api/test-users/:id/messages` body. */
export const testUserMessageRequestSchema = z.object({ text: z.string().max(20_000) });

/** `GET`/`PUT /admin/api/settings`: the settings in force and the defaults to compare with. */
export type SettingsResponse = {
  settings: Settings;
  defaults: Settings;
};

/** `GET /admin/api/stats` query: the period is by the time the questions were asked. */
export const adminStatsQuerySchema = z.object({
  from: isoTime.optional(),
  to: isoTime.optional(),
  /** `true` counts test users' questions too. */
  includeTest: flag.optional(),
});
export type AdminStatsQuery = z.infer<typeof adminStatsQuerySchema>;

/** `GET /admin/api/stats`: the numbers the time settings are tuned by. */
export const adminStatsSchema = z.object({
  questions: z.object({
    total: z.number().int(),
    queued: z.number().int(),
    assigned: z.number().int(),
    answered: z.number().int(),
    expired: z.number().int(),
    /** Expired among answered + expired, 0..1; `null` while nothing has finished. */
    expiredShare: z.number().min(0).max(1).nullable(),
    answeredByStaff: z.number().int(),
  }),
  /** Seconds from asking to the answer of a person; `null` when there is none. */
  averageSecondsToAnswer: z.number().nullable(),
  assignments: z.object({
    total: z.number().int(),
    active: z.number().int(),
    answered: z.number().int(),
    skipped: z.number().int(),
    timedOut: z.number().int(),
    reported: z.number().int(),
    undeliverable: z.number().int(),
  }),
  complaints: z.number().int(),
  queueSize: z.number().int(),
});
export type AdminStatsDto = z.infer<typeof adminStatsSchema>;
