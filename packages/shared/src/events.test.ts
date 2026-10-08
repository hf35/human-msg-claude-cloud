import { describe, expect, it } from 'vitest';
import { eventSchema, joinEvent, DOMAIN_EVENT_TYPES, splitEvent, type DomainEvent } from './events';

const examples: DomainEvent[] = [
  {
    type: 'question.assigned',
    questionId: 'q',
    text: 'Why?',
    authorAlias: 'Green Rabbit',
    deadlineAt: '2026-01-01T10:30:00.000Z',
  },
  { type: 'question.queued', questionId: 'q' },
  {
    type: 'answer.received',
    questionId: 'q',
    questionText: 'Why?',
    answerText: 'Because',
    responderAlias: 'Red Fox',
  },
  {
    type: 'assignment.reminder',
    questionId: 'q',
    deadlineAt: '2026-01-01T10:30:00.000Z',
    secondsLeft: 300,
  },
  { type: 'assignment.expired', questionId: 'q' },
  { type: 'question.expired', questionId: 'q' },
  { type: 'message.rejected', reason: 'dailyLimit' },
];

describe('outbox events', () => {
  it('has an example for every event type', () => {
    expect(examples.map((e) => e.type).sort()).toEqual([...DOMAIN_EVENT_TYPES].sort());
  });

  it.each(examples)('round-trips $type through type + payload', (event) => {
    const { type, payload } = splitEvent(event);
    expect(type).toBe(event.type);
    expect(payload).not.toHaveProperty('type');
    expect(joinEvent(type, payload)).toEqual(event);
  });

  it('rejects unknown types, missing fields and bad values', () => {
    expect(eventSchema.safeParse({ type: 'question.unknown' }).success).toBe(false);
    expect(eventSchema.safeParse({ type: 'question.queued' }).success).toBe(false);
    expect(eventSchema.safeParse({ type: 'message.rejected', reason: 'nope' }).success).toBe(false);
    expect(
      eventSchema.safeParse({
        type: 'assignment.reminder',
        questionId: 'q',
        deadlineAt: 'tomorrow',
        secondsLeft: 1,
      }).success,
    ).toBe(false);
  });
});
