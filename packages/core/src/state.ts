import { assignments, questions, users } from '@human-msg/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { CommandContext } from './context';
import { countRecentQuestions } from './questions';
import { fail, ok, type Result } from './result';

/** A question assigned to the user, waiting for their answer. */
export interface IncomingQuestion {
  questionId: string;
  text: string;
  authorAlias: string;
  assignedAt: Date;
  deadlineAt: Date;
}

/** The user's own question that has no answer yet. */
export interface PendingQuestion {
  questionId: string;
  text: string;
  /** `queued`: waiting for a free receiver; `assigned`: somebody is answering it. */
  status: 'queued' | 'assigned';
  createdAt: Date;
  expiresAt: Date;
}

export interface UserState {
  alias: string;
  locale: 'ru' | 'en';
  /** The question the user has to answer (they are busy while it is set). */
  assignment: IncomingQuestion | null;
  /** The user's own question without an answer (they cannot ask a new one while it is set). */
  pendingQuestion: PendingQuestion | null;
  /** The user gets no new questions before this moment; `null` when there is no pause. */
  cooldownUntil: Date | null;
  /** Questions asked in the last 24 hours against the limit. */
  questionLimit: { limit: number; used: number; remaining: number };
}

/**
 * Everything a client needs to draw the user's screen. "Busy" (`assignment`) and "awaiting an
 * answer" (`pendingQuestion`) are independent: a user can be both.
 */
export async function getUserState(
  ctx: CommandContext,
  userId: string,
): Promise<Result<UserState, 'user_not_found'>> {
  const { tx, time, settings } = ctx;
  const [user] = await tx
    .select({
      alias: users.alias,
      locale: users.locale,
      cooldownUntil: users.cooldownUntil,
      paused: sql<boolean>`coalesce(${users.cooldownUntil} > ${time.now()}, false)`,
    })
    .from(users)
    .where(eq(users.id, userId));
  if (!user) return fail('user_not_found');

  const [incoming] = await tx
    .select({
      questionId: questions.id,
      text: questions.text,
      authorAlias: users.alias,
      assignedAt: assignments.assignedAt,
      deadlineAt: assignments.deadlineAt,
    })
    .from(assignments)
    .innerJoin(questions, eq(questions.id, assignments.questionId))
    .innerJoin(users, eq(users.id, questions.authorId))
    .where(and(eq(assignments.receiverId, userId), isNull(assignments.outcome)));

  const [pending] = await tx
    .select({
      questionId: questions.id,
      text: questions.text,
      status: questions.status,
      createdAt: questions.createdAt,
      expiresAt: questions.expiresAt,
    })
    .from(questions)
    .where(and(eq(questions.authorId, userId), inArray(questions.status, ['queued', 'assigned'])));

  const used = await countRecentQuestions(ctx, userId);
  const limit = settings.QUESTIONS_PER_DAY;

  return ok({
    alias: user.alias,
    locale: user.locale,
    assignment: incoming ?? null,
    pendingQuestion: pending
      ? { ...pending, status: pending.status as 'queued' | 'assigned' }
      : null,
    cooldownUntil: user.paused ? user.cooldownUntil : null,
    questionLimit: { limit, used, remaining: Math.max(0, limit - used) },
  });
}
