import { findUserById, markUndeliverable, ok, readNow, type Core } from '@human-msg/core';
import {
  getTexts,
  isQuietHours,
  type Locale,
  type DomainEvent,
  type MessageRejectionReason,
  type Texts,
} from '@human-msg/shared';
import { GrammyError, type Api, type InlineKeyboard } from 'grammy';
import type { ChannelAdapter } from '../delivery/dispatcher';
import { answerKeyboard, questionKeyboard } from './keyboards';

/** Telegram refuses messages longer than this (counted in UTF-16 code units). */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

/** What to send for an event: the text and the buttons under it. */
interface Rendered {
  text: string;
  keyboard?: InlineKeyboard;
}

interface Limits {
  maxLength: number;
  perDay: number;
}

const minutesFrom = (seconds: number) => Math.max(1, Math.ceil(seconds / 60));

function rejection(t: Texts, reason: MessageRejectionReason, limits: Limits): string {
  switch (reason) {
    case 'empty':
      return t.rejections.messageEmpty;
    case 'tooShort':
      return t.rejections.messageTooShort;
    case 'tooLong':
      return t.rejections.messageTooLong(limits.maxLength);
    case 'notText':
      return t.rejections.onlyText;
    case 'awaitingAnswer':
      return t.rejections.awaitingAnswer;
    case 'dailyLimit':
      return t.rejections.dailyLimitReached(limits.perDay);
  }
}

/** Words of an event in the user's language, as a Telegram message. */
export function renderEvent(
  event: DomainEvent,
  locale: Locale,
  limits: Limits,
  createdAt: Date,
): Rendered {
  const t = getTexts(locale);
  switch (event.type) {
    case 'question.assigned': {
      const seconds = (new Date(event.deadlineAt).getTime() - createdAt.getTime()) / 1000;
      return {
        text: `${t.notifications.questionAssigned(event.authorAlias, minutesFrom(seconds))}\n\n${event.text}`,
        keyboard: questionKeyboard(locale, event.questionId),
      };
    }
    case 'question.queued':
      return { text: t.notifications.questionQueued };
    case 'answer.received':
      return {
        text: `${t.notifications.answerReceived(event.responderAlias)}\n\n${t.notifications.questionAndAnswer(event.questionText, event.answerText)}`,
        keyboard: answerKeyboard(locale, event.questionId),
      };
    case 'assignment.reminder':
      return { text: t.notifications.answerReminder(minutesFrom(event.secondsLeft)) };
    case 'assignment.expired':
      return { text: t.notifications.assignmentExpired };
    case 'question.expired':
      return { text: t.notifications.questionExpired };
    case 'receiving.auto_disabled':
      return { text: t.notifications.autoDoNotDisturb(event.missedDeadlines) };
    case 'message.rejected':
      return { text: rejection(t, event.reason, limits) };
  }
}

/** Cuts a long text into messages Telegram accepts, never inside a surrogate pair. */
export function splitMessage(text: string, limit = TELEGRAM_MESSAGE_LIMIT): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = limit;
    // Do not separate the halves of an emoji
    const last = rest.charCodeAt(cut - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  parts.push(rest);
  return parts;
}

const isBlocked = (error: unknown) => error instanceof GrammyError && error.error_code === 403;

/**
 * Delivers outbox events of Telegram users through the Bot API.
 *
 * - In quiet hours the message is sent without a sound (`disable_notification`).
 * - 403 means the user blocked the bot (rule 11): the core is told, and the event counts as
 *   delivered, because retrying cannot succeed.
 * - Any other failure (the network, 429 from Telegram) rejects, and the dispatcher retries with
 *   a growing pause.
 */
export function createTelegramAdapter({ api, core }: { api: Api; core: Core }): ChannelAdapter {
  return {
    async deliver(delivery) {
      const target = await core.run(async (command) => {
        const { tx, settings } = command;
        const user = await findUserById(tx, delivery.userId);
        return ok({
          telegramId: user?.telegramId ?? null,
          quiet: isQuietHours(
            await readNow(command),
            settings.QUIET_HOURS,
            settings.QUIET_HOURS_TZ,
          ),
          limits: { maxLength: settings.MESSAGE_MAX_LENGTH, perDay: settings.QUESTIONS_PER_DAY },
        });
      });
      if (!target.ok) throw new Error('cannot read the recipient');
      const { telegramId, quiet, limits } = target.value;
      // Nobody to write to: retrying will not help
      if (telegramId === null) return;

      const { text, keyboard } = renderEvent(
        delivery.event,
        delivery.locale,
        limits,
        delivery.createdAt,
      );
      const parts = splitMessage(text);
      try {
        for (const [index, part] of parts.entries()) {
          const last = index === parts.length - 1;
          await api.sendMessage(telegramId, part, {
            ...(quiet && { disable_notification: true }),
            ...(last && keyboard && { reply_markup: keyboard }),
          });
        }
      } catch (error) {
        if (!isBlocked(error)) throw error;
        await core.run((command) => markUndeliverable(command, delivery.userId));
      }
    },
  };
}
