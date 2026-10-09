export interface AttemptLimiterOptions {
  /** Failed attempts allowed within the window before further ones are refused. */
  maxFailures: number;
  windowMs: number;
  /** Clock in milliseconds; injectable for tests. */
  now?: () => number;
}

/**
 * Remembers failed sign-ins per key (the client address) and refuses new attempts after too many
 * within a window. In memory: it resets on restart, which is acceptable for a single back office.
 */
export class AttemptLimiter {
  private failures = new Map<string, number[]>();
  private readonly now: () => number;

  constructor(private readonly options: AttemptLimiterOptions) {
    this.now = options.now ?? Date.now;
  }

  private recent(key: string): number[] {
    const since = this.now() - this.options.windowMs;
    const recent = (this.failures.get(key) ?? []).filter((time) => time > since);
    if (recent.length > 0) this.failures.set(key, recent);
    else this.failures.delete(key);
    return recent;
  }

  /** Milliseconds until the key may try again; 0 when it may try now. */
  retryAfterMs(key: string): number {
    const recent = this.recent(key);
    if (recent.length < this.options.maxFailures) return 0;
    return recent[0]! + this.options.windowMs - this.now();
  }

  fail(key: string): void {
    this.failures.set(key, [...this.recent(key), this.now()]);
  }

  /** A successful sign-in clears the record. */
  reset(key: string): void {
    this.failures.delete(key);
  }
}
