import type { SettingsStore } from '@human-msg/core';
import { DEFAULT_SETTINGS, type SettingsResponse } from '@human-msg/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ADMIN_PATH } from './auth';

/** Only the keys sent are changed; the rest keep their values. Checked together by the store. */
const updateSchema = z.record(z.string(), z.unknown());

/**
 * Back office: product settings (deadlines, cooldowns, limits, quiet hours). A change is stored
 * in the database and applies at once, without a restart, to questions, assignments and pauses
 * created from now on: what was fixed at creation (`expires_at`, `deadline_at`, `cooldown_until`)
 * stays as it was.
 */
export function registerAdminSettings(
  app: FastifyInstance,
  { settings }: { settings: SettingsStore },
): void {
  const options = { preHandler: app.admin.require };
  const path = `${ADMIN_PATH}/api/settings`;

  app.get(path, options, async (): Promise<SettingsResponse> => {
    // The store caches for a few seconds; a screen opened right after a change must not lag
    settings.invalidate();
    return { settings: await settings.get(), defaults: DEFAULT_SETTINGS };
  });

  app.put(path, options, async (request, reply) => {
    const body = updateSchema.safeParse(request.body);
    if (!body.success || Object.keys(body.data).length === 0) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const result = await settings.set(body.data);
    if (!result.ok) {
      return reply.code(400).send({ error: result.reason, issues: result.issues });
    }
    const response: SettingsResponse = { settings: result.value, defaults: DEFAULT_SETTINGS };
    return response;
  });
}
