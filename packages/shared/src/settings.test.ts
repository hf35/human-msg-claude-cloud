import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, parseSettings, settingsSchema } from './settings';

describe('settings', () => {
  it('gives every default for an empty object', () => {
    expect(parseSettings({})).toEqual({
      QUESTION_TTL: 3 * 3600,
      ANSWER_TIMEOUT: 30 * 60,
      ANSWER_REMINDER: 5 * 60,
      COOLDOWN_TELEGRAM: 3600,
      COOLDOWN_WEB: 5 * 60,
      COOLDOWN_SKIP: 3600,
      QUIET_HOURS: '23:00-09:00',
      QUIET_HOURS_TZ: 'Europe/Moscow',
      QUESTIONS_PER_DAY: 10,
      AUTO_DND_AFTER_MISSED: 3,
      MESSAGE_MAX_LENGTH: 2000,
    });
    expect(parseSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps given values and fills in the rest', () => {
    const settings = parseSettings({
      ANSWER_TIMEOUT: 600,
      ANSWER_REMINDER: 60,
      QUIET_HOURS: '00:00-00:00',
    });
    expect(settings.ANSWER_TIMEOUT).toBe(600);
    expect(settings.QUIET_HOURS).toBe('00:00-00:00');
    expect(settings.QUESTION_TTL).toBe(DEFAULT_SETTINGS.QUESTION_TTL);
  });

  it('ignores unknown keys', () => {
    expect(parseSettings({ SOMETHING_ELSE: 1 })).toEqual(DEFAULT_SETTINGS);
  });

  it.each([
    ['a non-integer duration', { QUESTION_TTL: 1.5 }],
    ['a zero lifetime', { QUESTION_TTL: 0 }],
    ['a negative cooldown', { COOLDOWN_WEB: -1 }],
    ['a string instead of a number', { QUESTIONS_PER_DAY: '10' }],
    ['a zero question limit', { QUESTIONS_PER_DAY: 0 }],
    ['a message limit below the minimum length', { MESSAGE_MAX_LENGTH: 1 }],
    ['a malformed time range', { QUIET_HOURS: '25:00-09:00' }],
    ['an unknown time zone', { QUIET_HOURS_TZ: 'Mars/Olympus' }],
    ['a reminder not before the deadline', { ANSWER_TIMEOUT: 300, ANSWER_REMINDER: 300 }],
  ])('rejects %s', (_name, raw) => {
    expect(settingsSchema.safeParse(raw).success).toBe(false);
  });

  it('allows zero cooldowns', () => {
    const settings = parseSettings({ COOLDOWN_TELEGRAM: 0, COOLDOWN_WEB: 0, COOLDOWN_SKIP: 0 });
    expect(settings.COOLDOWN_SKIP).toBe(0);
  });
});
