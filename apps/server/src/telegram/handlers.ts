import {
  findUserByTelegramId,
  getOrCreateUser,
  ok,
  setUserLocale,
  type Core,
} from '@human-msg/core';
import type { User } from '@human-msg/db';
import {
  DEFAULT_LOCALE,
  LOCALES,
  getTexts,
  isLocale,
  parseLocale,
  type Locale,
} from '@human-msg/shared';
import { InlineKeyboard, type Bot, type Context } from 'grammy';

/** Names of the languages as people write them; the same in every language, so not in the catalogue. */
const LANGUAGE_NAMES: Record<Locale, string> = { ru: 'Русский', en: 'English' };

const LANGUAGE_CALLBACK = /^lang:(\w+)$/;

/** The user's language for an account that does not exist yet: the app language of their Telegram. */
const localeOf = (ctx: Context): Locale => parseLocale(ctx.from?.language_code) ?? DEFAULT_LOCALE;

/**
 * What the bot says and does for the commands that need no question logic. Every handler works
 * through the core: the bot has no database of its own.
 */
export function registerHandlers(bot: Bot, { core }: { core: Core }): void {
  /** Registers the person on first contact (their language comes from Telegram), else finds them. */
  async function registerUser(ctx: Context): Promise<{ user: User; created: boolean } | null> {
    const from = ctx.from;
    if (!from) return null;
    const result = await core.run(async ({ tx }) =>
      ok(
        await getOrCreateUser(tx, {
          channel: 'telegram',
          telegramId: from.id,
          locale: localeOf(ctx),
        }),
      ),
    );
    return result.ok ? result.value : null;
  }

  bot.command('start', async (ctx) => {
    const registered = await registerUser(ctx);
    if (!registered) return;
    const { user } = registered;
    const t = getTexts(user.locale);
    const limits = await core.run(async ({ settings }) =>
      ok({ maxLength: settings.MESSAGE_MAX_LENGTH, perDay: settings.QUESTIONS_PER_DAY }),
    );
    if (!limits.ok) return;
    await ctx.reply(
      `${t.bot.start(user.alias)}\n\n${t.bot.rules(limits.value.maxLength, limits.value.perDay)}`,
    );
  });

  // Help does not register anybody: a person who only asks what this is gets an answer in their
  // language and no account
  bot.command('help', async (ctx) => {
    const from = ctx.from;
    if (!from) return;
    const known = await core.run(async ({ tx }) => ok(await findUserByTelegramId(tx, from.id)));
    const locale = known.ok && known.value ? known.value.locale : localeOf(ctx);
    await ctx.reply(getTexts(locale).bot.help);
  });

  const languageKeyboard = () =>
    LOCALES.reduce(
      (keyboard, locale) => keyboard.text(LANGUAGE_NAMES[locale], `lang:${locale}`),
      new InlineKeyboard(),
    );

  async function changeLanguage(ctx: Context, locale: Locale): Promise<boolean> {
    const registered = await registerUser(ctx);
    if (!registered) return false;
    const userId = registered.user.id;
    const result = await core.run(async ({ tx }) => ok(await setUserLocale(tx, userId, locale)));
    if (!result.ok || result.value !== 'ok') return false;
    return true;
  }

  bot.command('language', async (ctx) => {
    const requested = ctx.match.trim().toLowerCase();
    if (isLocale(requested)) {
      if (await changeLanguage(ctx, requested))
        await ctx.reply(getTexts(requested).bot.languageChanged);
      return;
    }
    const registered = await registerUser(ctx);
    if (!registered) return;
    await ctx.reply(getTexts(registered.user.locale).bot.languagePrompt, {
      reply_markup: languageKeyboard(),
    });
  });

  bot.callbackQuery(LANGUAGE_CALLBACK, async (ctx) => {
    const requested = ctx.match[1];
    if (!isLocale(requested)) return ctx.answerCallbackQuery();
    const changed = await changeLanguage(ctx, requested);
    await ctx.answerCallbackQuery();
    if (changed) await ctx.editMessageText(getTexts(requested).bot.languageChanged);
  });
}
