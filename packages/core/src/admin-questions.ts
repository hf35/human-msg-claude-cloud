import {
  answers,
  assignments,
  questions,
  users,
  type AssignmentOutcome,
  type QuestionStatus,
} from '@human-msg/db';
import { aliasedTable, and, getTableColumns, desc, eq, inArray, sql } from 'drizzle-orm';
import type { CommandContext } from './context';
import { ok, type Result } from './result';

export const ADMIN_QUESTIONS_MAX_LIMIT = 100;

export interface QuestionFilter {
  status?: QuestionStatus;
  authorId?: string;
}

/** One handing of a question to a receiver. */
export interface AdminAssignment {
  receiverId: string;
  receiverAlias: string;
  assignedAt: Date;
  deadlineAt: Date;
  endedAt: Date | null;
  /** `null` while the assignment is active. */
  outcome: AssignmentOutcome | null;
}

/** A question as the back office sees it: who asked, who got it, what came back. */
export interface AdminQuestion {
  id: string;
  text: string;
  status: QuestionStatus;
  authorId: string;
  authorAlias: string;
  createdAt: Date;
  expiresAt: Date;
  answeredAt: Date | null;
  answer: { text: string; responderId: string; responderAlias: string; createdAt: Date } | null;
  /** Oldest first. */
  assignments: AdminAssignment[];
}

export interface AdminQuestionPage {
  items: AdminQuestion[];
  total: number;
}

/** Back office: questions, newest first, with their assignments and answers. */
export async function listQuestions(
  { tx }: CommandContext,
  filter: QuestionFilter = {},
  options: { limit?: number; offset?: number } = {},
): Promise<Result<AdminQuestionPage, never>> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), ADMIN_QUESTIONS_MAX_LIMIT);
  const offset = Math.max(options.offset ?? 0, 0);
  const authors = aliasedTable(users, 'authors');
  const where = and(
    filter.status ? eq(questions.status, filter.status) : undefined,
    filter.authorId ? eq(questions.authorId, filter.authorId) : undefined,
  );

  const rows = await tx
    .select({
      question: getTableColumns(questions),
      authorAlias: authors.alias,
    })
    .from(questions)
    .innerJoin(authors, eq(authors.id, questions.authorId))
    .where(where)
    .orderBy(desc(questions.createdAt), desc(questions.id))
    .limit(limit)
    .offset(offset);
  const [{ total } = { total: 0 }] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(questions)
    .where(where);

  const ids = rows.map((row) => row.question.id);
  // Separate queries: two aliases of `users` in one select make Drizzle's types collapse
  const replies =
    ids.length === 0
      ? []
      : await tx
          .select({
            questionId: answers.questionId,
            text: answers.text,
            createdAt: answers.createdAt,
            responderId: answers.authorId,
            responderAlias: users.alias,
          })
          .from(answers)
          .innerJoin(users, eq(users.id, answers.authorId))
          .where(inArray(answers.questionId, ids));
  const handed =
    ids.length === 0
      ? []
      : await tx
          .select({
            questionId: assignments.questionId,
            receiverId: assignments.receiverId,
            receiverAlias: users.alias,
            assignedAt: assignments.assignedAt,
            deadlineAt: assignments.deadlineAt,
            endedAt: assignments.endedAt,
            outcome: assignments.outcome,
          })
          .from(assignments)
          .innerJoin(users, eq(users.id, assignments.receiverId))
          .where(inArray(assignments.questionId, ids))
          .orderBy(assignments.assignedAt);

  return ok({
    total,
    items: rows.map((row) => ({
      id: row.question.id,
      text: row.question.text,
      status: row.question.status,
      authorId: row.question.authorId,
      authorAlias: row.authorAlias,
      createdAt: row.question.createdAt,
      expiresAt: row.question.expiresAt,
      answeredAt: row.question.answeredAt,
      answer: (() => {
        const reply = replies.find((candidate) => candidate.questionId === row.question.id);
        return reply
          ? {
              text: reply.text,
              responderId: reply.responderId,
              responderAlias: reply.responderAlias,
              createdAt: reply.createdAt,
            }
          : null;
      })(),
      assignments: handed
        .filter((assignment) => assignment.questionId === row.question.id)
        .map((assignment) => ({
          receiverId: assignment.receiverId,
          receiverAlias: assignment.receiverAlias,
          assignedAt: assignment.assignedAt,
          deadlineAt: assignment.deadlineAt,
          endedAt: assignment.endedAt,
          outcome: assignment.outcome,
        })),
    })),
  });
}
