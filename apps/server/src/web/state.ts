import { getUserState, setUserLocale, type Core, type UserState } from '@human-msg/core';
import { updateMeRequestSchema, type MeResponse, type StateResponse } from '@human-msg/shared';
import type { FastifyInstance } from 'fastify';

const iso = (date: Date) => date.toISOString();

/** The `/state` part of the user's state in its wire format (times as ISO strings). */
export function toStateResponse(state: UserState): StateResponse {
  const { assignment, pendingQuestion } = state;
  return {
    assignment: assignment && {
      ...assignment,
      assignedAt: iso(assignment.assignedAt),
      deadlineAt: iso(assignment.deadlineAt),
    },
    pendingQuestion: pendingQuestion && {
      ...pendingQuestion,
      createdAt: iso(pendingQuestion.createdAt),
      expiresAt: iso(pendingQuestion.expiresAt),
    },
  };
}

export function toMeResponse(state: UserState): MeResponse {
  return {
    alias: state.alias,
    locale: state.locale,
    awaitingAnswer: state.pendingQuestion !== null,
    busy: state.assignment !== null,
    cooldownUntil: state.cooldownUntil && iso(state.cooldownUntil),
    questionLimit: state.questionLimit,
    messageMaxLength: state.messageMaxLength,
  };
}

export function registerStateRoutes(app: FastifyInstance, { core }: { core: Core }): void {
  const load = async (userId: string): Promise<UserState | null> => {
    const result = await core.run((ctx) => getUserState(ctx, userId));
    return result.ok ? result.value : null;
  };

  app.get('/api/me', { preHandler: app.sessions.requireUser }, async (request, reply) => {
    const state = await load(request.user!.id);
    // The user was deleted while the session was alive
    if (!state) return reply.code(401).send({ error: 'unauthorized' });
    return toMeResponse(state);
  });

  app.patch('/api/me', { preHandler: app.sessions.requireUser }, async (request, reply) => {
    const body = updateMeRequestSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
    const userId = request.user!.id;
    const result = await core.run(async (ctx) => {
      if ((await setUserLocale(ctx.tx, userId, body.data.locale)) === 'user_not_found') {
        return { ok: false as const, reason: 'user_not_found' as const };
      }
      return getUserState(ctx, userId);
    });
    if (!result.ok) return reply.code(401).send({ error: 'unauthorized' });
    return toMeResponse(result.value);
  });

  app.get('/api/state', { preHandler: app.sessions.requireUser }, async (request, reply) => {
    const state = await load(request.user!.id);
    if (!state) return reply.code(401).send({ error: 'unauthorized' });
    return toStateResponse(state);
  });
}
