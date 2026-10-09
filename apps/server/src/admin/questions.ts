import { listQuestions, staffAnswer, type AdminQuestion, type Core } from '@human-msg/core';
import {
  adminQuestionsQuerySchema,
  staffAnswerRequestSchema,
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

  // The journal of questions nobody answered is `GET /admin/api/questions?status=expired`; this
  // answers one of them. The answer is stored as an ordinary one (rule 4) and reaches the author
  // like any other.
  app.post(
    `${ADMIN_PATH}/api/questions/:id/staff-answer`,
    { preHandler: app.admin.require },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!UUID.test(id)) return reply.code(404).send({ error: 'not_found' });
      const body = staffAnswerRequestSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_request' });

      const result = await core.run((ctx) => staffAnswer(ctx, id, body.data.text));
      if (result.ok) return reply.code(201).send({ questionId: id });
      if (result.reason === 'not_found') return reply.code(404).send({ error: result.reason });
      if (result.reason === 'not_expired') return reply.code(409).send({ error: result.reason });
      return reply.code(400).send({ error: result.reason });
    },
  );
}
