import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Db } from './client';

// drizzle-kit writes the SQL files here (see drizzle.config.ts)
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

// Arbitrary constant key of the advisory lock that serializes migration runs
const MIGRATION_LOCK_KEY = 727_001;

/**
 * Applies all pending migrations. Safe to run repeatedly and concurrently (parallel test files,
 * several server instances): runs are serialized by a session-level advisory lock.
 */
export async function runMigrations(db: Db): Promise<void> {
  // The lock belongs to a connection, so lock and unlock must use the same one
  const client = await db.$client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}
