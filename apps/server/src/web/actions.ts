import {
  handleIncomingText,
  reportAnswer,
  reportQuestion,
  skipAssignment,
  type Core,
} from '@human-msg/core';
import {
  reportRequestSchema,
  sendMessageRequestSchema,
  type ActionError,
  type MessageRejectionReason,
  type SendMessageResponse,
} from '@human-msg/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';

/** HTTP status of each refusal: a malformed input, a state conflict, or a limit. */
const MESSAGE_STATUS: Record<MessageRejectionReason, number> = {
  empty: 400,
  tooShort: 400,
  tooLong: 400,
  notText: 400,
  awaitingAnswer: 409,
  dailyLimit: 429,
};

const refuse = (reply: FastifyReply, status: number, error: ActionError) =>
  reply.code(status).send({ error });

/**
 * Things the user does: send a text (an answer or a new question), skip the question assigned
 * to them, complain. The rules live in the core; this layer only translates the outcome.
 */
export function registerActionRoutes(app: FastifyInstance, { core }: { core: Core }): void {
  const options = { preHandler: app.sessions.requireUser };

  app.post('/api/messages', options, async (request, reply) => {
    const body = sendMessageRequestSchema.safeParse(request.body);
    if (!body.success) return refuse(reply, 400, 'invalid_request');
    const text = typeof body.data.text === 'string' ? body.data.text : null;

    const result = await core.run((ctx) => handleIncomingText(ctx, request.user!.id, text));
    if (result.ok) {
      const { value } = result;
      const response: SendMessageResponse =
        value.kind === 'answered'
          ? { kind: 'answered', questionId: value.questionId }
          : { kind: 'asked', questionId: value.questionId, status: value.status };
      return response;
    }
    if (result.reason === 'user_not_found') return refuse(reply, 401, 'unauthorized');
    return refuse(reply, MESSAGE_STATUS[result.reason], result.reason);
  });

  app.post('/api/assignment/skip', options, async (request, reply) => {
    const result = await core.run((ctx) => skipAssignment(ctx, request.user!.id));
    if (!result.ok) return refuse(reply, 409, result.reason);
    return result.value;
  });

  app.post('/api/reports', options, async (request, reply) => {
    const body = reportRequestSchema.safeParse(request.body);
    if (!body.success) return refuse(reply, 400, 'invalid_request');
    const userId = request.user!.id;

    if (body.data.target === 'question') {
      const result = await core.run((ctx) => reportQuestion(ctx, userId));
      if (!result.ok) return refuse(reply, 409, result.reason);
      return result.value;
    }
    const { questionId } = body.data;
    const result = await core.run((ctx) => reportAnswer(ctx, userId, questionId));
    if (!result.ok) return refuse(reply, result.reason === 'not_found' ? 404 : 409, result.reason);
    return { questionId };
  });
}
