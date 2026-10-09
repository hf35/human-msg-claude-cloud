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
