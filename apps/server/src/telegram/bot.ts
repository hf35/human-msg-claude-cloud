import type { Core } from '@human-msg/core';
import { apiThrottler } from '@grammyjs/transformer-throttler';
import { Bot, type BotConfig, type Context } from 'grammy';
import { registerHandlers } from './handlers';

export interface BotOptions {
  token: string;
  core: Core;
  /** Address of the Bot API; the real one by default, a local server for tests. */
  apiRoot?: string;
  /** Skips the `getMe` call when it is known already (tests). */
  botInfo?: BotConfig<Context>['botInfo'];
}

/**
 * The Telegram bot. It talks to the rest of the system only through the core, like the web API.
 * Sending is throttled by grammY's plugin so that Telegram's limits (about 30 messages a second
 * overall, one a second per chat) are kept.
 */
export function createBot(options: BotOptions): Bot {
  const { token, apiRoot, botInfo } = options;
  const bot = new Bot(token, {
    ...(botInfo && { botInfo }),
    ...(apiRoot && { client: { apiRoot } }),
  });
  bot.api.config.use(apiThrottler());

  registerHandlers(bot, { core: options.core });

  return bot;
}
