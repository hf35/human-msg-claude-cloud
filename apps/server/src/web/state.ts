import { getUserState, type Core, type UserState } from '@human-msg/core';
import type { MeResponse, StateResponse } from '@human-msg/shared';
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

  app.get('/api/state', { preHandler: app.sessions.requireUser }, async (request, reply) => {
    const state = await load(request.user!.id);
    if (!state) return reply.code(401).send({ error: 'unauthorized' });
    return toStateResponse(state);
  });
}
