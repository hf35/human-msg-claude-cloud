import { settings as settingsTable, type Db } from '@human-msg/db';
import { DEFAULT_SETTINGS, parseSettings, settingsSchema, type Settings } from '@human-msg/shared';
import { eq } from 'drizzle-orm';
import type { SettingsSource } from './context';

/** How long a read value is reused; changes from the back office apply within this time. */
export const SETTINGS_CACHE_MS = 5_000;

export type SettingKey = keyof Settings;
const KEYS = Object.keys(DEFAULT_SETTINGS) as SettingKey[];

/** Result of saving settings; `issues` explain a refusal in a form fit for the back office. */
export type SetSettingsResult =
  | { ok: true; value: Settings }
  | { ok: false; reason: 'unknown_key' | 'invalid'; issues: string[] };

export interface SettingsStore extends SettingsSource {
  /** Saves the given values (validated together with the stored ones) and drops the cache. */
  set(values: Record<string, unknown>): Promise<SetSettingsResult>;
  /** Removes stored values, so the keys fall back to their defaults. */
  reset(...keys: SettingKey[]): Promise<void>;
  /** Forgets the cached value; the next read goes to the database. */
  invalidate(): void;
}

export interface SettingsStoreOptions {
  db: Db;
  cacheMs?: number;
  /** Clock of the cache in milliseconds; injectable for tests. */
  clock?: () => number;
}

/**
 * Product settings stored in the `settings` table (key → value). A missing row means "use the
 * default". Reads are cached for a few seconds, so the database is not asked on every command.
 */
export function createSettingsStore(options: SettingsStoreOptions): SettingsStore {
  const { db, cacheMs = SETTINGS_CACHE_MS, clock = Date.now } = options;
  let cached: { settings: Settings; loadedAt: number } | undefined;
  // Concurrent readers share one query
  let loading: Promise<Settings> | undefined;
  // Counts invalidations. A read that started before one may hold values from before the change,
  // so it must not be cached.
  let generation = 0;

  async function loadRaw(): Promise<Record<string, unknown>> {
    const rows = await db.select().from(settingsTable);
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  function invalidate(): void {
    cached = undefined;
    // The query in flight may predate the change; the next reader starts a new one
    loading = undefined;
    generation++;
  }

  return {
    invalidate,

    async get() {
      if (cached && clock() - cached.loadedAt < cacheMs) return cached.settings;
      if (!loading) {
        const started = generation;
        const load: Promise<Settings> = loadRaw()
          .then((raw) => {
            const settings = parseSettings(raw);
            if (generation === started) cached = { settings, loadedAt: clock() };
            return settings;
          })
          .finally(() => {
            if (loading === load) loading = undefined;
          });
        loading = load;
      }
      return loading;
    },

    async set(values) {
      const unknown = Object.keys(values).find((key) => !KEYS.includes(key as SettingKey));
      if (unknown !== undefined) {
        return { ok: false, reason: 'unknown_key', issues: [`${unknown}: unknown setting`] };
      }

      const result = await db.transaction(async (tx) => {
        const rows = await tx.select().from(settingsTable);
        const raw = { ...Object.fromEntries(rows.map((row) => [row.key, row.value])), ...values };
        const parsed = settingsSchema.safeParse(raw);
        if (!parsed.success) {
          const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
          return { ok: false, reason: 'invalid', issues } satisfies SetSettingsResult;
        }
        for (const [key, value] of Object.entries(values)) {
          await tx
            .insert(settingsTable)
            .values({ key, value })
            .onConflictDoUpdate({
              target: settingsTable.key,
              set: { value, updatedAt: new Date() },
            });
        }
        return { ok: true, value: parsed.data } satisfies SetSettingsResult;
      });
      // Only after the commit: dropping the cache earlier lets a reader that runs before the commit
      // cache the old values for the whole cache period
      if (result.ok) invalidate();
      return result;
    },

    async reset(...keys) {
      for (const key of keys) {
        await db.delete(settingsTable).where(eq(settingsTable.key, key));
      }
      invalidate();
    },
  };
}
