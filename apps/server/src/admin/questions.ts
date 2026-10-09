import { listQuestions, type AdminQuestion, type Core } from '@human-msg/core';
import {
  adminQuestionsQuerySchema,
  type AdminQuestionDto,
  type AdminQuestionsResponse,
} from '@human-msg/shared';
import type { FastifyInstance } from 'fastify';
import { ADMIN_PATH } from './auth';

export const toAdminQuestionDto = (question: AdminQuestion): AdminQuestionDto => ({
  ...question,
  createdAt: question.createdAt.toISOString(),
  expiresAt: question.expiresAt.toISOString(),
  answeredAt: question.answeredAt?.toISOString() ?? null,
  answer: question.answer && {
    ...question.answer,
    createdAt: question.answer.createdAt.toISOString(),
  },
  assignments: question.assignments.map((assignment) => ({
    ...assignment,
    assignedAt: assignment.assignedAt.toISOString(),
    deadlineAt: assignment.deadlineAt.toISOString(),
    endedAt: assignment.endedAt?.toISOString() ?? null,
  })),
});

/** Back office: all questions by status, with their assignments and answers. */
export function registerAdminQuestions(app: FastifyInstance, { core }: { core: Core }): void {
  app.get(
    `${ADMIN_PATH}/api/questions`,
    { preHandler: app.admin.require },
    async (request, reply) => {
      const query = adminQuestionsQuerySchema.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: 'invalid_request' });
      const { limit, offset, ...filter } = query.data;

      const result = await core.run((ctx) => listQuestions(ctx, filter, { limit, offset }));
      if (!result.ok) throw new Error('unreachable');
      const response: AdminQuestionsResponse = {
        items: result.value.items.map(toAdminQuestionDto),
        total: result.value.total,
      };
      return response;
    },
  );
}
