import { sql, type SQL } from 'drizzle-orm';

/**
 * Where "now" comes from. Business rules compare times inside SQL, so the source hands out an
 * SQL expression instead of a JS date: it is `now()` of the database (not of Node.js, whose
 * clock may differ), optionally shifted in tests.
 */
export interface TimeSource {
  /** SQL expression for the current time; embed it into queries instead of calling `now()`. */
  now(): SQL<Date>;
}

/** The real database time. */
export const systemTime: TimeSource = {
  now: () => sql<Date>`now()`,
};

/** A time source whose clock can be moved forward, for tests of timeouts and cooldowns. */
export interface ManualTime extends TimeSource {
  /** Moves the clock forward by the given number of milliseconds. */
  advance(ms: number): void;
  /** Puts the clock back to the real database time. */
  reset(): void;
}

export function createManualTime(): ManualTime {
  let offsetMs = 0;
  return {
    now: () =>
      offsetMs === 0
        ? sql<Date>`now()`
        : sql<Date>`now() + (${offsetMs / 1000}::double precision * interval '1 second')`,
    advance(ms) {
      offsetMs += ms;
    },
    reset() {
      offsetMs = 0;
    },
  };
}
