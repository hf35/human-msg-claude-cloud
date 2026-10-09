import type { Core } from '@human-msg/core';
import { webhookCallback, type Bot } from 'grammy';
import type { FastifyInstance } from 'fastify';
import { createTelegramAdapter } from './adapter';
import { createBot } from './bot';
import type { ChannelAdapter } from '../delivery/dispatcher';

export * from './adapter';
export * from './bot';

/** Path Telegram posts updates to in webhook mode. */
export const WEBHOOK_PATH = '/telegram/webhook';

export interface TelegramOptions {
  token: string;
  core: Core;
  apiRoot?: string;
  /**
   * How updates arrive. Long polling (default) asks Telegram for them; a webhook makes Telegram
   * post them to `${url}${WEBHOOK_PATH}` on `app`, and every request must carry `secret`.
   */
  mode?: 'polling' | 'webhook';
  webhook?: { url: string; secret: string };
  /** The HTTP server that receives webhook requests; required in webhook mode. */
  app?: FastifyInstance;
  log: {
    info(message: string): void;
    error(object: { err: unknown }, message: string): void;
  };
}

export interface RunningTelegram {
  bot: Bot;
  /** Delivers outbox events of Telegram users through this bot. */
  adapter: ChannelAdapter;
  /** Stops receiving updates; the update being handled is finished first. */
  stop(): Promise<void>;
}

/**
 * Starts the bot. The token is checked first (`getMe`): a wrong token or an unreachable Telegram
 * fails the start with a clear error instead of a bot that silently does nothing.
 */
export async function startTelegram(options: TelegramOptions): Promise<RunningTelegram> {
  const { log, mode = 'polling', webhook, app, core } = options;
  if (mode === 'webhook' && (!webhook || !app)) {
    throw new Error('Telegram webhook mode needs a public URL, a secret and the HTTP server');
  }
  const bot = createBot(options);
  bot.catch((error) => log.error({ err: error.error }, 'telegram update failed'));
  const adapter = createTelegramAdapter({ api: bot.api, core });

  try {
    await bot.init();
  } catch (error) {
    throw new Error(
      `Telegram bot cannot start: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const allowedUpdates = ['message', 'callback_query'] as const;

  if (mode === 'webhook' && webhook && app) {
    // grammY answers 401 to requests without the right secret header
    const handle = webhookCallback(bot, 'fastify', { secretToken: webhook.secret });
    app.post(WEBHOOK_PATH, handle);
    try {
      await bot.api.setWebhook(`${webhook.url}${WEBHOOK_PATH}`, {
        secret_token: webhook.secret,
        allowed_updates: [...allowedUpdates],
      });
    } catch (error) {
      throw new Error(
        `Telegram webhook cannot be set: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    log.info(`telegram bot @${bot.botInfo.username} receives updates by webhook`);
    return { bot, adapter, stop: async () => {} };
  }

  // `start` resolves only when the bot stops, so it is not awaited
  const polling = bot
    .start({
      allowed_updates: [...allowedUpdates],
      onStart: (me) => log.info(`telegram bot @${me.username} is polling`),
    })
    .catch((error: unknown) => log.error({ err: error }, 'telegram polling stopped'));

  return {
    bot,
    adapter,
    async stop() {
      await bot.stop();
      await polling;
    },
  };
}
