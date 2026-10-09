import { getAdminUser, getHistory, listUsers, type AdminUser, type Core } from '@human-msg/core';
import {
  adminUsersQuerySchema,
  historyQuerySchema,
  type AdminUserDto,
  type AdminUsersResponse,
  type HistoryResponse,
} from '@human-msg/shared';
import type { FastifyInstance } from 'fastify';
import { toHistoryDto } from '../web/history';
import { ADMIN_PATH } from './auth';

const iso = (date: Date | null) => date?.toISOString() ?? null;

export const toAdminUserDto = (user: AdminUser): AdminUserDto => ({
  id: user.id,
  channel: user.channel,
  alias: user.alias,
  locale: user.locale,
  telegramId: user.telegramId,
  isTest: user.isTest,
  isStaff: user.isStaff,
  receivingEnabled: user.receivingEnabled,
  missedDeadlines: user.missedDeadlines,
  botBlockedAt: iso(user.botBlockedAt),
  cooldownUntil: iso(user.cooldownUntil),
  lastSeenAt: iso(user.lastSeenAt),
  createdAt: user.createdAt.toISOString(),
  questionsAsked: user.questionsAsked,
  answersGiven: user.answersGiven,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Back office: who is registered, and what each of them asked and answered. */
export function registerAdminUsers(app: FastifyInstance, { core }: { core: Core }): void {
  const options = { preHandler: app.admin.require };

  app.get(`${ADMIN_PATH}/api/users`, options, async (request, reply) => {
    const query = adminUsersQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_request' });
    const { limit, offset, createdFrom, createdTo, ...rest } = query.data;

    const result = await core.run((ctx) =>
      listUsers(
        ctx,
        {
          ...rest,
          ...(createdFrom && { createdFrom: new Date(createdFrom) }),
          ...(createdTo && { createdTo: new Date(createdTo) }),
        },
        { limit, offset },
      ),
    );
    if (!result.ok) throw new Error('unreachable');
    const response: AdminUsersResponse = {
      items: result.value.items.map(toAdminUserDto),
      total: result.value.total,
    };
    return response;
  });

  app.get(`${ADMIN_PATH}/api/users/:id`, options, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(404).send({ error: 'not_found' });
    const result = await core.run((ctx) => getAdminUser(ctx, id));
    if (!result.ok) return reply.code(404).send({ error: result.reason });
    return toAdminUserDto(result.value);
  });

  // The user's conversation: what they asked with the answers, and what they answered
  app.get(`${ADMIN_PATH}/api/users/:id/history`, options, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(404).send({ error: 'not_found' });
    const query = historyQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_request' });
    const { limit, cursor } = query.data;

    const result = await core.run(async (ctx) => {
      const user = await getAdminUser(ctx, id);
      if (!user.ok) return user;
      return getHistory(ctx, id, { limit, ...(cursor && { cursor }) });
    });
    if (!result.ok) {
      return reply.code(result.reason === 'not_found' ? 404 : 400).send({ error: result.reason });
    }
    const response: HistoryResponse = {
      items: result.value.items.map(toHistoryDto),
      nextCursor: result.value.nextCursor,
    };
    return response;
  });
}
