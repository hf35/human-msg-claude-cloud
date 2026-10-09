import { getHistory, type Core, type HistoryItem } from '@human-msg/core';
import { historyQuerySchema, type HistoryResponse } from '@human-msg/shared';
import type { FastifyInstance } from 'fastify';

const toDto = (item: HistoryItem): HistoryResponse['items'][number] =>
  item.kind === 'question'
    ? {
        ...item,
        createdAt: item.createdAt.toISOString(),
        answer: item.answer && { ...item.answer, createdAt: item.answer.createdAt.toISOString() },
      }
    : { ...item, createdAt: item.createdAt.toISOString() };

export function registerHistoryRoutes(app: FastifyInstance, { core }: { core: Core }): void {
  app.get('/api/history', { preHandler: app.sessions.requireUser }, async (request, reply) => {
    const query = historyQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_request' });
    const { limit, cursor } = query.data;

    const result = await core.run((ctx) =>
      getHistory(ctx, request.user!.id, { limit, ...(cursor && { cursor }) }),
    );
    if (!result.ok) return reply.code(400).send({ error: result.reason });
    const response: HistoryResponse = {
      items: result.value.items.map(toDto),
      nextCursor: result.value.nextCursor,
    };
    return response;
  });
}
