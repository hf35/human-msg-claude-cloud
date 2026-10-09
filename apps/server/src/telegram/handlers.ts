import {
  findUserByTelegramId,
  getOrCreateUser,
  getUserState,
  handleIncomingText,
  markReachable,
  ok,
  fail,
  reportAnswer,
  reportQuestion,
  setReceiving,
  setUserLocale,
  skipAssignment,
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
import { ANSWER_REPORT_CALLBACK, QUESTION_REPORT_CALLBACK, SKIP_CALLBACK } from './keyboards';

/** Names of the languages as people write them; the same in every language, so not in the catalogue. */
const LANGUAGE_NAMES: Record<Locale, string> = { ru: 'Русский', en: 'English' };

const LANGUAGE_CALLBACK = /^lang:(\w+)$/;

/** The user's language for an account that does not exist yet: the app language of their Telegram. */
const localeOf = (ctx: Context): Locale => parseLocale(ctx.from?.language_code) ?? DEFAULT_LOCALE;

/**
 * What the bot says and does. Every handler works through the core: the bot has no database of
 * its own. Answers to messages that go through the core (refusals, "searching for an answerer")
 * are not sent here: the core writes them to the outbox and the Telegram adapter delivers them.
 */
export function registerHandlers(bot: Bot, { core }: { core: Core }): void {
  /**
   * The person behind the update, registered on first contact (their language comes from
   * Telegram). Writing to the bot proves it is not blocked, so the person is reachable again.
   */
  async function identify(ctx: Context): Promise<User | null> {
    const from = ctx.from;
    if (!from) return null;
    const result = await core.run(async (command) => {
      const { user } = await getOrCreateUser(command.tx, {
        channel: 'telegram',
        telegramId: from.id,
        locale: localeOf(ctx),
      });
      await markReachable(command, user.id);
      return ok(user);
    });
    return result.ok ? result.value : null;
  }

  bot.use(async (ctx, next) => {
    // The bot is for private chats only: a group has no single person to answer
    if (ctx.chat?.type === 'private') await next();
  });

  bot.command('start', async (ctx) => {
    const user = await identify(ctx);
    if (!user) return;
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
  const sendHelp = async (ctx: Context) => {
    const from = ctx.from;
    if (!from) return;
    const known = await core.run(async ({ tx }) => ok(await findUserByTelegramId(tx, from.id)));
    const locale = known.ok && known.value ? known.value.locale : localeOf(ctx);
    await ctx.reply(getTexts(locale).bot.help);
  };
  bot.command('help', sendHelp);

  // Receiving questions off ("do not disturb") and on again. `/resume` also brings back people
  // whom the bot switched off after missed deadlines: it is the same switch.
  bot.command('stop', async (ctx) => {
    const user = await identify(ctx);
    if (!user) return;
    const result = await core.run((command) => setReceiving(command, user.id, false));
    if (result.ok) await ctx.reply(getTexts(user.locale).bot.stopped);
  });

  bot.command('resume', async (ctx) => {
    const user = await identify(ctx);
    if (!user) return;
    const result = await core.run((command) => setReceiving(command, user.id, true));
    if (result.ok) await ctx.reply(getTexts(user.locale).bot.resumed);
  });

  const languageKeyboard = () =>
    LOCALES.reduce(
      (keyboard, locale) => keyboard.text(LANGUAGE_NAMES[locale], `lang:${locale}`),
      new InlineKeyboard(),
    );

  async function changeLanguage(ctx: Context, locale: Locale): Promise<boolean> {
    const user = await identify(ctx);
    if (!user) return false;
    const result = await core.run(async ({ tx }) => ok(await setUserLocale(tx, user.id, locale)));
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
    const user = await identify(ctx);
    if (!user) return;
    await ctx.reply(getTexts(user.locale).bot.languagePrompt, {
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

  // Buttons under messages. The question id in the data ties a button to its own question: a
  // button of an old message must not act on the question the person has now.
  const dropKeyboard = (ctx: Context) => ctx.editMessageReplyMarkup().catch(() => {});

  bot.callbackQuery(SKIP_CALLBACK, async (ctx) => {
    const user = await identify(ctx);
    if (!user) return ctx.answerCallbackQuery();
    const questionId = ctx.match[1]!;
    const result = await core.run(async (command) => {
      const state = await getUserState(command, user.id);
      if (!state.ok || state.value.assignment?.questionId !== questionId) return fail('stale');
      return skipAssignment(command, user.id);
    });
    const t = getTexts(user.locale);
    await dropKeyboard(ctx);
    await ctx.answerCallbackQuery({
      text: result.ok ? t.notifications.skipped : t.rejections.answerTimeExpired,
    });
  });

  bot.callbackQuery(QUESTION_REPORT_CALLBACK, async (ctx) => {
    const user = await identify(ctx);
    if (!user) return ctx.answerCallbackQuery();
    const questionId = ctx.match[1]!;
    const result = await core.run(async (command) => {
      const state = await getUserState(command, user.id);
      if (!state.ok || state.value.assignment?.questionId !== questionId) return fail('stale');
      return reportQuestion(command, user.id);
    });
    const t = getTexts(user.locale);
    await dropKeyboard(ctx);
    await ctx.answerCallbackQuery({
      text: result.ok ? t.notifications.reported : t.rejections.answerTimeExpired,
    });
  });

  bot.callbackQuery(ANSWER_REPORT_CALLBACK, async (ctx) => {
    const user = await identify(ctx);
    if (!user) return ctx.answerCallbackQuery();
    const questionId = ctx.match[1]!;
    const result = await core.run((command) => reportAnswer(command, user.id, questionId));
    await dropKeyboard(ctx);
    await ctx.answerCallbackQuery(
      result.ok ? { text: getTexts(user.locale).notifications.answerReported } : {},
    );
  });

  // Commands the bot does not know are not questions
  bot.on('message:entities:bot_command', async (ctx, next) => {
    const first = ctx.message.entities.find((entity) => entity.offset === 0);
    if (first?.type === 'bot_command') return sendHelp(ctx);
    return next();
  });

  // Anything else is a message for the core: an answer, or a new question. What the person is
  // told back (searching, refused, ...) comes from the core through the outbox.
  bot.on('message', async (ctx) => {
    const user = await identify(ctx);
    if (!user) return;
    const text = ctx.message.text ?? null;
    await core.run((command) => handleIncomingText(command, user.id, text));
  });
}
