import { z } from 'zod';
import { eventSchema } from './events';
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
  'invalid_cursor',
] as const;
export type ActionError = (typeof ACTION_ERRORS)[number];

/** `GET /api/history` query. */
export const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  /** The `nextCursor` of the previous page. */
  cursor: z.string().min(1).optional(),
});
export type HistoryQuery = z.infer<typeof historyQuerySchema>;

/** An item of the history: a question the user asked, or an answer the user gave. */
export const historyItemSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('question'),
    id: z.string(),
    questionId: z.string(),
    text: z.string(),
    status: z.enum(['queued', 'assigned', 'answered', 'expired']),
    createdAt: isoTime,
    /** The answer with the question it belongs to; `null` while there is none. */
    answer: z
      .object({ text: z.string(), responderAlias: z.string(), createdAt: isoTime })
      .nullable(),
  }),
  z.object({
    kind: z.literal('answer'),
    id: z.string(),
    questionId: z.string(),
    /** The user's own answer. */
    text: z.string(),
    questionText: z.string(),
    authorAlias: z.string(),
    createdAt: isoTime,
  }),
]);
export type HistoryItemDto = z.infer<typeof historyItemSchema>;

/** `GET /api/history`: newest first. */
export const historyResponseSchema = z.object({
  items: z.array(historyItemSchema),
  /** Pass as `cursor` to get the next page; `null` on the last page. */
  nextCursor: z.string().nullable(),
});
export type HistoryResponse = z.infer<typeof historyResponseSchema>;

/**
 * A message the server sends over the WebSocket: one event of the outbox. Delivery is at least
 * once, so a client ignores a message whose `id` it has already seen.
 */
export const wsMessageSchema = z.object({
  id: z.number().int(),
  createdAt: isoTime,
  event: eventSchema,
});
export type WsMessage = z.infer<typeof wsMessageSchema>;

/** Answer of the sign-in routes: who has just signed in. */
export const authResponseSchema = z.object({ alias: z.string(), locale });
export type AuthResponse = z.infer<typeof authResponseSchema>;

/** Answer of `POST /api/assignment/skip` and of the reports: the question concerned. */
export const questionRefResponseSchema = z.object({ questionId: z.string() });
export type QuestionRefResponse = z.infer<typeof questionRefResponseSchema>;

/** Body of every refused request: a machine-readable reason (see `ACTION_ERRORS`). */
export const errorResponseSchema = z.object({ error: z.string() });

/** `PATCH /api/me`: the user switches the interface language; it is stored in their profile. */
export const updateMeRequestSchema = z.object({ locale });
export type UpdateMeRequest = z.infer<typeof updateMeRequestSchema>;
