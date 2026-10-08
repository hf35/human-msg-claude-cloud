import { systemTime } from '@human-msg/db';
import { DEFAULT_SETTINGS } from '@human-msg/shared';
import type { CommandContext, CoreDeps, SettingsSource } from './context';
import type { Result } from './result';

/** Settings that never change; used until settings are read from the database. */
export function staticSettings(settings = DEFAULT_SETTINGS): SettingsSource {
  return { get: async () => settings };
}

export interface Core {
  /**
   * Runs one command as one database transaction.
   *
   * - The transaction commits when the command returns a result, successful or not: a refusal
   *   may still have to leave something behind (for example an event for the user).
   *   A command that refuses must not write anything it does not want to keep.
   * - The transaction rolls back and the error is rethrown when the command throws.
   */
  run<T, R extends string>(
    command: (ctx: CommandContext) => Promise<Result<T, R>>,
  ): Promise<Result<T, R>>;
}

export function createCore(deps: Partial<CoreDeps> & Pick<CoreDeps, 'db'>): Core {
  const { db, time = systemTime, settings = staticSettings() } = deps;
  return {
    async run(command) {
      const snapshot = await settings.get();
      return db.transaction((tx) => command({ tx, time, settings: snapshot }));
    },
  };
}
