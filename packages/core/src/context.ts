import type { Db, TimeSource, Tx } from '@human-msg/db';
import type { Settings } from '@human-msg/shared';

/** Supplies the current product settings (see `settingsSchema` in `@human-msg/shared`). */
export interface SettingsSource {
  get(): Promise<Settings>;
}

/** Everything the core needs from the outside world. */
export interface CoreDeps {
  db: Db;
  /** Where "now" comes from; tests move it. Defaults to the database clock. */
  time: TimeSource;
  settings: SettingsSource;
}

/** What a command sees while it runs: one transaction, one clock, one settings snapshot. */
export interface CommandContext {
  tx: Tx;
  time: TimeSource;
  /** Read once at the start of the command, so the whole command uses consistent values. */
  settings: Settings;
}
