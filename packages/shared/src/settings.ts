import { z } from 'zod';
import { MIN_MESSAGE_LENGTH } from './message';
import { parseTimeRange } from './quiet-hours';

const MINUTE = 60;
const HOUR = 60 * MINUTE;

/** A duration in whole seconds. Zero is allowed where "no wait" makes sense. */
const seconds = (defaultValue: number, min = 1) => z.number().int().min(min).default(defaultValue);

const timeRange = z.string().refine(
  (value) => {
    try {
      parseTimeRange(value);
      return true;
    } catch {
      return false;
    }
  },
  { message: 'Expected a time range like "23:00-09:00"' },
);

const timeZone = z.string().refine(
  (value) => {
    try {
      new Intl.DateTimeFormat('en-GB', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'Expected an IANA time zone like "Europe/Moscow"' },
);

/**
 * Product settings that are edited in the back office and stored in the `settings` table
 * (key → value). Durations are whole seconds. Every key has a default from `CLAUDE.md`, so an
 * empty object is valid and a missing row in the table means "use the default".
 */
export const settingsSchema = z
  .object({
    /** Total lifetime of a question; checked only when the question is being assigned. */
    QUESTION_TTL: seconds(3 * HOUR),
    /** Time one recipient has to answer. */
    ANSWER_TIMEOUT: seconds(30 * MINUTE),
    /** How long before the deadline the recipient is reminded. */
    ANSWER_REMINDER: seconds(5 * MINUTE),
    /** Cooldown after an answer in Telegram. */
    COOLDOWN_TELEGRAM: seconds(HOUR, 0),
    /** Cooldown after an answer on the web. */
    COOLDOWN_WEB: seconds(5 * MINUTE, 0),
    /** Cooldown after a skip or a missed deadline, in both channels. */
    COOLDOWN_SKIP: seconds(HOUR, 0),
    /** Telegram quiet hours as "HH:MM-HH:MM"; equal start and end switch them off. */
    QUIET_HOURS: timeRange.default('23:00-09:00'),
    QUIET_HOURS_TZ: timeZone.default('Europe/Moscow'),
    /**
     * A Telegram user who misses this many deadlines in a row gets "do not disturb" switched on
     * automatically. A reply or a skip resets the count; 0 switches the feature off.
     */
    AUTO_DND_AFTER_MISSED: z.number().int().min(0).default(3),
    /** Questions a user may ask within a rolling 24 hours. */
    QUESTIONS_PER_DAY: z.number().int().min(1).default(10),
    /** Maximum length of a question or an answer, in visible characters. */
    MESSAGE_MAX_LENGTH: z.number().int().min(MIN_MESSAGE_LENGTH).max(10_000).default(2000),
  })
  .refine((settings) => settings.ANSWER_REMINDER < settings.ANSWER_TIMEOUT, {
    path: ['ANSWER_REMINDER'],
    message: 'The reminder must come before the answer deadline',
  });

export type Settings = z.infer<typeof settingsSchema>;

/** All settings with their default values. */
export const DEFAULT_SETTINGS: Settings = settingsSchema.parse({});

/**
 * Builds the settings from the raw `settings` table (key → value). Missing keys get their
 * defaults; unknown keys are ignored. Throws a `ZodError` for an invalid value.
 */
export function parseSettings(raw: Record<string, unknown> = {}): Settings {
  return settingsSchema.parse(raw);
}
