import type { Core } from '@human-msg/core';
import type { Bot } from 'grammy';
import { createBot } from './bot';

export * from './bot';

export interface TelegramOptions {
  token: string;
  core: Core;
  apiRoot?: string;
  log: {
    info(message: string): void;
    error(object: { err: unknown }, message: string): void;
  };
}

export interface RunningTelegram {
  bot: Bot;
  /** Stops receiving updates; the update being handled is finished first. */
  stop(): Promise<void>;
}

/**
 * Starts the bot with long polling. The token is checked first (`getMe`): a wrong token or an
 * unreachable Telegram fails the start with a clear error instead of a bot that silently does
 * nothing.
 */
export async function startTelegram(options: TelegramOptions): Promise<RunningTelegram> {
  const { log } = options;
  const bot = createBot(options);
  bot.catch((error) => log.error({ err: error.error }, 'telegram update failed'));

  try {
    await bot.init();
  } catch (error) {
    throw new Error(
      `Telegram bot cannot start: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  // `start` resolves only when the bot stops, so it is not awaited
  const polling = bot
    .start({
      allowed_updates: ['message', 'callback_query'],
      onStart: (me) => log.info(`telegram bot @${me.username} is polling`),
    })
    .catch((error: unknown) => log.error({ err: error }, 'telegram polling stopped'));

  return {
    bot,
    async stop() {
      await bot.stop();
      await polling;
    },
  };
}
