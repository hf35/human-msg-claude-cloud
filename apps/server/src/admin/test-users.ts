import {
  createTestAccount,
  getAdminUser,
  getTestUserState,
  sendAsTestUser,
  setTestUserReceiving,
  skipAsTestUser,
  type Core,
} from '@human-msg/core';
import {
  createTestUserRequestSchema,
  testUserMessageRequestSchema,
  testUserReceivingRequestSchema,
} from '@human-msg/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { toStateResponse } from '../web/state';
import { ADMIN_PATH } from './auth';
import { toAdminUserDto } from './users';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const STATUS: Record<string, number> = {
  not_found: 404,
  // A real user is not touched from here, and this is not hidden behind a 404: it is a mistake
  not_test_user: 403,
  no_active_assignment: 409,
  awaitingAnswer: 409,
  dailyLimit: 429,
};
const refuse = (reply: FastifyReply, reason: string) =>
  reply.code(STATUS[reason] ?? 400).send({ error: reason });

/**
 * Back office: test users, who play several people at once. They are listed with the ordinary
 * `GET /admin/api/users?isTest=true`. Every action is refused for a user who is not a test user.
 */
export function registerAdminTestUsers(app: FastifyInstance, { core }: { core: Core }): void {
  const options = { preHandler: app.admin.require };
  const base = `${ADMIN_PATH}/api/test-users`;

  const idOf = (request: { params: unknown }) => {
    const { id } = request.params as { id: string };
    return UUID.test(id) ? id : null;
  };

  app.post(base, options, async (request, reply) => {
    const body = createTestUserRequestSchema.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
    const result = await core.run(async (ctx) => {
      const created = await createTestAccount(ctx, body.data.locale);
      return created.ok ? getAdminUser(ctx, created.value.id) : created;
    });
    if (!result.ok) return refuse(reply, result.reason);
    return reply.code(201).send(toAdminUserDto(result.value));
  });

  app.put(`${base}/:id/receiving`, options, async (request, reply) => {
    const id = idOf(request);
    if (!id) return refuse(reply, 'not_found');
    const body = testUserReceivingRequestSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
    const result = await core.run((ctx) =>
      setTestUserReceiving(ctx, id, body.data.receivingEnabled),
    );
    if (!result.ok) return refuse(reply, result.reason);
    return { receivingEnabled: body.data.receivingEnabled };
  });

  // What the test user would see on their screen: the question they must answer, their own wait
  app.get(`${base}/:id/state`, options, async (request, reply) => {
    const id = idOf(request);
    if (!id) return refuse(reply, 'not_found');
    const result = await core.run((ctx) => getTestUserState(ctx, id));
    if (!result.ok) return refuse(reply, result.reason);
    return toStateResponse(result.value);
  });

  app.post(`${base}/:id/messages`, options, async (request, reply) => {
    const id = idOf(request);
    if (!id) return refuse(reply, 'not_found');
    const body = testUserMessageRequestSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
    const result = await core.run((ctx) => sendAsTestUser(ctx, id, body.data.text));
    if (!result.ok) {
      return refuse(reply, result.reason === 'user_not_found' ? 'not_found' : result.reason);
    }
    return result.value.kind === 'answered'
      ? { kind: 'answered', questionId: result.value.questionId }
      : { kind: 'asked', questionId: result.value.questionId, status: result.value.status };
  });

  app.post(`${base}/:id/skip`, options, async (request, reply) => {
    const id = idOf(request);
    if (!id) return refuse(reply, 'not_found');
    const result = await core.run((ctx) => skipAsTestUser(ctx, id));
    if (!result.ok) return refuse(reply, result.reason);
    return result.value;
  });
}
