/** A daily time range as minutes since midnight. The end is exclusive; the range may wrap midnight. */
export interface TimeRange {
  startMinutes: number;
  endMinutes: number;
}

const TIME = String.raw`([01]\d|2[0-3]):([0-5]\d)`;
const RANGE = new RegExp(String.raw`^\s*${TIME}\s*[-–—]\s*${TIME}\s*$`);

/**
 * Parses a range like "23:00-09:00" (a hyphen, en dash or em dash may separate the times).
 * Throws a `RangeError` for anything else.
 */
export function parseTimeRange(range: string): TimeRange {
  const match = RANGE.exec(range);
  if (!match) {
    throw new RangeError(
      `Invalid time range "${range}", expected "HH:MM-HH:MM" like "23:00-09:00"`,
    );
  }
  const [, startHours, startMinutes, endHours, endMinutes] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
  ];
  return {
    startMinutes: Number(startHours) * 60 + Number(startMinutes),
    endMinutes: Number(endHours) * 60 + Number(endMinutes),
  };
}

// Building a formatter is slow, and there are only a few time zones in use
const formatters = new Map<string, Intl.DateTimeFormat>();

function minutesSinceMidnight(date: Date, timeZone: string): number {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    // h23 keeps midnight as "00" instead of "24"; throws a RangeError for an unknown time zone
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(date);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return part('hour') * 60 + part('minute');
}

/**
 * Whether `now` falls into the quiet hours of the given time zone, e.g. "23:00-09:00" in
 * "Europe/Moscow". The start is included and the end is excluded: 23:00 is quiet, 09:00 is not.
 * A range that ends before it starts wraps midnight. Equal start and end mean "never quiet",
 * which is how quiet hours are switched off.
 * Daylight saving time is handled by the time zone database.
 */
export function isQuietHours(now: Date, range: string | TimeRange, timeZone: string): boolean {
  const { startMinutes, endMinutes } = typeof range === 'string' ? parseTimeRange(range) : range;
  if (startMinutes === endMinutes) return false;

  const minutes = minutesSinceMidnight(now, timeZone);
  return startMinutes < endMinutes
    ? minutes >= startMinutes && minutes < endMinutes
    : minutes >= startMinutes || minutes < endMinutes;
}
