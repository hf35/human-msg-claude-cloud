import { getStats, type Core } from '@human-msg/core';
import { adminStatsQuerySchema, type AdminStatsDto } from '@human-msg/shared';
import type { FastifyInstance } from 'fastify';
import { ADMIN_PATH } from './auth';

/** Back office: the share of unanswered questions, time to answer, skips, complaints, the queue. */
export function registerAdminStats(app: FastifyInstance, { core }: { core: Core }): void {
  app.get(`${ADMIN_PATH}/api/stats`, { preHandler: app.admin.require }, async (request, reply) => {
    const query = adminStatsQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_request' });
    const { from, to, includeTest } = query.data;

    const result = await core.run((ctx) =>
      getStats(ctx, {
        ...(from && { from: new Date(from) }),
        ...(to && { to: new Date(to) }),
        ...(includeTest !== undefined && { includeTest }),
      }),
    );
    if (!result.ok) throw new Error('unreachable');
    const stats: AdminStatsDto = result.value;
    return stats;
  });
}
