/** A question or an answer must have at least this many characters. */
export const MIN_MESSAGE_LENGTH = 2;

/** Why a text was rejected. The values match the keys of `rejections` in the texts catalogue. */
export type MessageRejection = 'empty' | 'tooShort' | 'tooLong';

export type MessageValidation =
  { ok: true; text: string } | { ok: false; reason: MessageRejection };

// A single user-perceived character, e.g. an emoji with modifiers or a letter with accents
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// C0 and C1 control characters except tab and newline. NUL in particular cannot be stored in PostgreSQL.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

// Characters that show nothing: zero-width characters, joiners, bidi marks, the soft hyphen
// and the fillers that are used to send a message that looks empty
const INVISIBLE = /^(?:[\p{Cf}\u115F\u1160\u3164\uFFA0]|\u034F|\u17B4|\u17B5)+$/u;

// Any of the above or whitespace. All of them are single UTF-16 code units, which is
// what lets `trimBlank` walk the string from both ends without a backtracking regex.
const BLANK_CHARACTER = /^(?:[\s\p{Cf}\u115F\u1160\u3164\uFFA0]|\u034F|\u17B4|\u17B5)$/u;

// A real character is at most about 8 UTF-16 code units (a family emoji). A text longer than
// this per allowed character is rejected without counting graphemes, so one "character" with
// endless combining marks stays cheap to check.
const MAX_CODE_UNITS_PER_CHARACTER = 8;

function trimBlank(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && BLANK_CHARACTER.test(text.charAt(start))) start++;
  while (end > start && BLANK_CHARACTER.test(text.charAt(end - 1))) end--;
  return text.slice(start, end);
}

/**
 * Checks the text of a question or an answer and cleans it up: line endings become `\n`,
 * control characters are dropped, spaces and invisible characters around the text are trimmed.
 * Length is counted in characters as the user sees them (invisible ones do not count),
 * not in bytes.
 */
export function validateMessageText(text: string, maxLength: number): MessageValidation {
  if (!Number.isInteger(maxLength) || maxLength < MIN_MESSAGE_LENGTH) {
    throw new RangeError(`maxLength must be an integer of at least ${MIN_MESSAGE_LENGTH}`);
  }

  const cleaned = trimBlank(text.replace(/\r\n?/g, '\n').replace(CONTROL_CHARACTERS, ''));

  if (cleaned === '') return { ok: false, reason: 'empty' };
  if (cleaned.length > maxLength * MAX_CODE_UNITS_PER_CHARACTER) {
    return { ok: false, reason: 'tooLong' };
  }

  let length = 0;
  for (const { segment } of graphemes.segment(cleaned)) {
    if (!INVISIBLE.test(segment)) length++;
  }

  if (length === 0) return { ok: false, reason: 'empty' };
  if (length < MIN_MESSAGE_LENGTH) return { ok: false, reason: 'tooShort' };
  if (length > maxLength) return { ok: false, reason: 'tooLong' };

  return { ok: true, text: cleaned };
}
