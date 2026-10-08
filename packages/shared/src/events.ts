import { z } from 'zod';

/** Why an incoming message was refused; the user gets the matching text (see the texts catalogue). */
export const MESSAGE_REJECTION_REASONS = [
  'empty',
  'tooShort',
  'tooLong',
  'notText',
  'awaitingAnswer',
  'dailyLimit',
] as const;
export type MessageRejectionReason = (typeof MESSAGE_REJECTION_REASONS)[number];

const id = z.string().min(1);
const timestamp = z.iso.datetime();

/**
 * Events the core writes to the outbox for delivery to a user (ARCHITECTURE.md, section 9).
 * `type` is stored in its own column, the rest is the payload. Times are ISO strings.
 */
export const eventSchema = z.discriminatedUnion('type', [
  /** To the receiver: a question was assigned to them. */
  z.object({
    type: z.literal('question.assigned'),
    questionId: id,
    text: z.string(),
    authorAlias: z.string(),
    deadlineAt: timestamp,
  }),
  /** To the author: nobody is available yet, the question waits in the queue. */
  z.object({ type: z.literal('question.queued'), questionId: id }),
  /** To the author: the answer arrives together with the original question. */
  z.object({
    type: z.literal('answer.received'),
    questionId: id,
    questionText: z.string(),
    answerText: z.string(),
    responderAlias: z.string(),
  }),
  /** To the receiver: the deadline is close. */
  z.object({
    type: z.literal('assignment.reminder'),
    questionId: id,
    deadlineAt: timestamp,
    secondsLeft: z.number().int().min(0),
  }),
  /** To the receiver: the time to answer is over. */
  z.object({ type: z.literal('assignment.expired'), questionId: id }),
  /** To the author: nobody managed to answer in time. */
  z.object({ type: z.literal('question.expired'), questionId: id }),
  /** To the sender: the message was refused. */
  z.object({
    type: z.literal('message.rejected'),
    reason: z.enum(MESSAGE_REJECTION_REASONS),
  }),
]);

export type DomainEvent = z.infer<typeof eventSchema>;
export type DomainEventType = DomainEvent['type'];
export const DOMAIN_EVENT_TYPES = eventSchema.options.map((option) => option.shape.type.value);

/** Splits an event into the outbox `type` column and its `payload`. */
export function splitEvent(event: DomainEvent): {
  type: DomainEventType;
  payload: Record<string, unknown>;
} {
  const { type, ...payload } = eventSchema.parse(event);
  return { type, payload };
}

/** Reads an event back from an outbox row; throws if the row does not match any event. */
export function joinEvent(type: string, payload: unknown): DomainEvent {
  return eventSchema.parse({ ...(payload as object), type });
}
