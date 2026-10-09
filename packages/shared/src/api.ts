import { z } from 'zod';
import { LOCALES } from './texts';

/**
 * Contracts of the web API (ARCHITECTURE.md, section 11): request bodies are validated with these
 * schemas on the server and typed with them in the web client.
 */

/** Language the interface was shown in; used only when the account is created. */
const locale = z.enum(LOCALES);

/** `POST /api/auth/google`: the ID token from Google Identity Services. */
export const googleLoginRequestSchema = z.object({
  idToken: z.string().min(1),
  locale: locale.optional(),
});
export type GoogleLoginRequest = z.infer<typeof googleLoginRequestSchema>;

/** `POST /api/auth/dev`: sign-in without Google, development only. The name picks the account. */
export const devLoginRequestSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[\w .-]+$/),
  locale: locale.optional(),
});
export type DevLoginRequest = z.infer<typeof devLoginRequestSchema>;

const isoTime = z.iso.datetime();

/** A question assigned to the user. The author is known only by alias. */
export const incomingQuestionSchema = z.object({
  questionId: z.string(),
  text: z.string(),
  authorAlias: z.string(),
  assignedAt: isoTime,
  deadlineAt: isoTime,
});
export type IncomingQuestionDto = z.infer<typeof incomingQuestionSchema>;

/** The user's own question that has no answer yet. */
export const pendingQuestionSchema = z.object({
  questionId: z.string(),
  text: z.string(),
  status: z.enum(['queued', 'assigned']),
  createdAt: isoTime,
  expiresAt: isoTime,
});
export type PendingQuestionDto = z.infer<typeof pendingQuestionSchema>;

/** `GET /api/state`: what the screen shows right now. */
export const stateResponseSchema = z.object({
  /** The question to answer; the user is busy while it is set. */
  assignment: incomingQuestionSchema.nullable(),
  /** The user's own question waiting for an answer; asking a new one is refused meanwhile. */
  pendingQuestion: pendingQuestionSchema.nullable(),
});
export type StateResponse = z.infer<typeof stateResponseSchema>;

/** `GET /api/me`: the profile, the state flags and the question limit. */
export const meResponseSchema = z.object({
  alias: z.string(),
  locale,
  /** Waiting for an answer to their own question. */
  awaitingAnswer: z.boolean(),
  /** Has a question assigned to them to answer. */
  busy: z.boolean(),
  /** No new questions are assigned before this time; `null` when there is no pause. */
  cooldownUntil: isoTime.nullable(),
  questionLimit: z.object({
    limit: z.number().int(),
    used: z.number().int(),
    remaining: z.number().int(),
  }),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

/** `POST /api/messages`: any text of the user; the server decides whether it is an answer or a question. */
export const sendMessageRequestSchema = z.object({
  // Anything but a string is refused by the core as "not text", like a photo in Telegram
  text: z.unknown(),
});

/** What `POST /api/messages` did with the text. */
export const sendMessageResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('answered'), questionId: z.string() }),
  z.object({
    kind: z.literal('asked'),
    questionId: z.string(),
    /** `assigned`: already with a receiver; `queued`: waits for a free one. */
    status: z.enum(['assigned', 'queued']),
  }),
]);
export type SendMessageResponse = z.infer<typeof sendMessageResponseSchema>;

/**
 * `POST /api/reports`: a complaint either about the question assigned to the user now, or about
 * the answer to one of their questions.
 */
export const reportRequestSchema = z.discriminatedUnion('target', [
  z.object({ target: z.literal('question') }),
  z.object({ target: z.literal('answer'), questionId: z.uuid() }),
]);
export type ReportRequest = z.infer<typeof reportRequestSchema>;

/** Machine-readable reasons of a refused action, the `error` field of a 4xx response. */
export const ACTION_ERRORS = [
  'invalid_request',
  'unauthorized',
  // Messages (the same reasons the Telegram bot answers with)
  'empty',
  'tooShort',
  'tooLong',
  'notText',
  'awaitingAnswer',
  'dailyLimit',
  // Skip and reports
  'no_active_assignment',
  'not_found',
  'not_answered',
] as const;
export type ActionError = (typeof ACTION_ERRORS)[number];
