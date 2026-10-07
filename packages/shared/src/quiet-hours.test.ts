import { describe, expect, it } from 'vitest';
import { isQuietHours, parseTimeRange } from './quiet-hours';

const NIGHT = '23:00-09:00';
const MOSCOW = 'Europe/Moscow'; // UTC+3 all year

function quiet(iso: string, range = NIGHT, timeZone = MOSCOW) {
  return isQuietHours(new Date(iso), range, timeZone);
}

describe('parseTimeRange', () => {
  it('parses a range into minutes since midnight', () => {
    expect(parseTimeRange('23:00-09:00')).toEqual({ startMinutes: 1380, endMinutes: 540 });
    expect(parseTimeRange('00:00-23:59')).toEqual({ startMinutes: 0, endMinutes: 1439 });
    expect(parseTimeRange('08:30-17:45')).toEqual({ startMinutes: 510, endMinutes: 1065 });
  });

  it('accepts hyphen, en dash and em dash, with spaces around', () => {
    const expected = { startMinutes: 1380, endMinutes: 540 };
    expect(parseTimeRange('23:00–09:00')).toEqual(expected);
    expect(parseTimeRange('23:00—09:00')).toEqual(expected);
    expect(parseTimeRange(' 23:00 - 09:00 ')).toEqual(expected);
  });

  it.each(['', '23:00', '23:00-', '9:00-10:00', '24:00-09:00', '23:60-09:00', '23-09', 'night'])(
    'rejects "%s"',
    (range) => {
      expect(() => parseTimeRange(range)).toThrow(RangeError);
    },
  );
});

describe('isQuietHours', () => {
  describe('a range that wraps midnight (23:00-09:00, Moscow)', () => {
    it.each([
      ['2026-01-15T19:59:59Z', 'one second before the start (22:59:59)', false],
      ['2026-01-15T20:00:00Z', 'the start (23:00)', true],
      ['2026-01-15T20:30:00Z', 'evening (23:30)', true],
      ['2026-01-15T21:00:00Z', 'midnight (00:00)', true],
      ['2026-01-15T00:30:00Z', 'night (03:30)', true],
      ['2026-01-15T05:59:00Z', 'one minute before the end (08:59)', true],
      ['2026-01-15T05:59:59Z', 'one second before the end (08:59:59)', true],
      ['2026-01-15T06:00:00Z', 'the end (09:00)', false],
      ['2026-01-15T09:00:00Z', 'noon (12:00)', false],
    ])('%s: %s -> %s', (iso, _description, expected) => {
      expect(quiet(iso)).toBe(expected);
    });
  });

  describe('a range inside one day (13:00-14:30)', () => {
    const range = '13:00-14:30';
    it.each([
      ['2026-01-15T09:59:00Z', false], // 12:59
      ['2026-01-15T10:00:00Z', true], // 13:00
      ['2026-01-15T11:29:00Z', true], // 14:29
      ['2026-01-15T11:30:00Z', false], // 14:30
      ['2026-01-15T21:00:00Z', false], // midnight
    ])('%s -> %s', (iso, expected) => {
      expect(quiet(iso, range)).toBe(expected);
    });
  });

  describe('time zones', () => {
    const instant = '2026-01-15T12:00:00Z';

    it('uses the clock of the given time zone', () => {
      expect(quiet(instant, NIGHT, 'UTC')).toBe(false); // 12:00
      expect(quiet(instant, NIGHT, MOSCOW)).toBe(false); // 15:00
      expect(quiet(instant, NIGHT, 'Asia/Tokyo')).toBe(false); // 21:00
      expect(quiet(instant, NIGHT, 'Asia/Vladivostok')).toBe(false); // 22:00
      expect(quiet(instant, NIGHT, 'Pacific/Auckland')).toBe(true); // 01:00 (summer time)
      expect(quiet(instant, NIGHT, 'America/Los_Angeles')).toBe(true); // 04:00
      expect(quiet('2026-01-15T17:00:00Z', NIGHT, 'America/Los_Angeles')).toBe(false); // 09:00
      expect(quiet('2026-01-15T07:00:00Z', NIGHT, 'America/Los_Angeles')).toBe(true); // 23:00
    });

    it('handles zones with a half-hour offset', () => {
      // India is UTC+5:30
      expect(quiet('2026-01-15T17:29:00Z', NIGHT, 'Asia/Kolkata')).toBe(false); // 22:59
      expect(quiet('2026-01-15T17:30:00Z', NIGHT, 'Asia/Kolkata')).toBe(true); // 23:00
      expect(quiet('2026-01-15T03:29:00Z', NIGHT, 'Asia/Kolkata')).toBe(true); // 08:59
      expect(quiet('2026-01-15T03:30:00Z', NIGHT, 'Asia/Kolkata')).toBe(false); // 09:00
    });

    it('follows daylight saving time', () => {
      // New York is UTC-5 in winter and UTC-4 in summer
      expect(quiet('2026-01-15T04:30:00Z', NIGHT, 'America/New_York')).toBe(true); // 23:30 EST
      expect(quiet('2026-01-15T03:30:00Z', NIGHT, 'America/New_York')).toBe(false); // 22:30 EST
      expect(quiet('2026-07-15T03:30:00Z', NIGHT, 'America/New_York')).toBe(true); // 23:30 EDT
      expect(quiet('2026-07-15T02:30:00Z', NIGHT, 'America/New_York')).toBe(false); // 22:30 EDT
    });

    it('keeps working across a daylight saving change', () => {
      // Berlin skips from 02:00 to 03:00 on 2026-03-29: 01:59 CET is followed by 03:00 CEST
      const range = '02:00-03:00';
      expect(quiet('2026-03-29T00:59:00Z', range, 'Europe/Berlin')).toBe(false); // 01:59 CET
      expect(quiet('2026-03-29T01:00:00Z', range, 'Europe/Berlin')).toBe(false); // 03:00 CEST
      expect(quiet('2026-03-30T00:00:00Z', range, 'Europe/Berlin')).toBe(true); // 02:00 CEST
      expect(quiet('2026-03-30T00:59:00Z', range, 'Europe/Berlin')).toBe(true); // 02:59 CEST
      expect(quiet('2026-03-30T01:00:00Z', range, 'Europe/Berlin')).toBe(false); // 03:00 CEST
    });

    it('counts the right number of quiet minutes on the days the clocks change', () => {
      const minutes = (fromIso: string, toIso: string, range: string) => {
        let count = 0;
        for (let t = Date.parse(fromIso); t < Date.parse(toIso); t += 60_000) {
          if (isQuietHours(new Date(t), range, 'Europe/Berlin')) count++;
        }
        return count;
      };
      // Spring: the local hour 02:00-03:00 does not exist, so it is never quiet (a 23 hour day)
      expect(minutes('2026-03-28T23:00:00Z', '2026-03-29T22:00:00Z', '02:00-03:00')).toBe(0);
      // Autumn: the local hour 02:00-03:00 happens twice (a 25 hour day)
      expect(minutes('2026-10-24T22:00:00Z', '2026-10-25T23:00:00Z', '02:00-03:00')).toBe(120);
      // 23:00-09:00 on a local day: 9 night hours in the morning + 1 in the evening, minus the
      // missing hour in spring (540 minutes) and plus the extra hour in autumn (660 minutes)
      expect(minutes('2026-03-28T23:00:00Z', '2026-03-29T22:00:00Z', '23:00-09:00')).toBe(540);
      expect(minutes('2026-10-24T22:00:00Z', '2026-10-25T23:00:00Z', '23:00-09:00')).toBe(660);
    });

    it('throws for an unknown time zone', () => {
      expect(() => quiet(instant, NIGHT, 'Mars/Olympus')).toThrow(RangeError);
    });
  });

  describe('special ranges', () => {
    it('is never quiet when start and end are equal', () => {
      for (const iso of ['2026-01-15T00:00:00Z', '2026-01-15T12:00:00Z', '2026-01-15T23:59:00Z']) {
        expect(quiet(iso, '23:00-23:00', 'UTC')).toBe(false);
      }
    });

    it('treats an end at midnight as the end of the day', () => {
      expect(quiet('2026-01-15T17:59:00Z', '18:00-00:00', 'UTC')).toBe(false);
      expect(quiet('2026-01-15T18:00:00Z', '18:00-00:00', 'UTC')).toBe(true);
      expect(quiet('2026-01-15T23:59:00Z', '18:00-00:00', 'UTC')).toBe(true);
      expect(quiet('2026-01-16T00:00:00Z', '18:00-00:00', 'UTC')).toBe(false);
    });

    it('covers nearly the whole day', () => {
      expect(quiet('2026-01-15T00:00:00Z', '00:00-23:59', 'UTC')).toBe(true);
      expect(quiet('2026-01-15T23:58:00Z', '00:00-23:59', 'UTC')).toBe(true);
      expect(quiet('2026-01-15T23:59:00Z', '00:00-23:59', 'UTC')).toBe(false);
    });

    it('accepts an already parsed range', () => {
      const range = parseTimeRange(NIGHT);
      expect(isQuietHours(new Date('2026-01-15T20:30:00Z'), range, MOSCOW)).toBe(true);
      expect(isQuietHours(new Date('2026-01-15T09:00:00Z'), range, MOSCOW)).toBe(false);
    });

    it('throws for a range that cannot be parsed', () => {
      expect(() => quiet('2026-01-15T12:00:00Z', 'night')).toThrow(RangeError);
    });
  });
});
