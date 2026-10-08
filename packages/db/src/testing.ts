import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createDb, createPool, type Db } from './client';
import { runMigrations } from './migrate';

// The database of `docker compose up postgres`; CI sets DATABASE_URL
const DEV_DATABASE_URL = 'postgres://humanmsg:humanmsg@localhost:5432/humanmsg';

/**
 * Test helpers; imported as `@human-msg/db/testing`, never from production code.
 *
 * Test files run in parallel, so each one gets its own freshly created database: tables can be
 * truncated between tests without touching the data of other files.
 */
export interface TestDatabase {
  db: Db;
  pool: pg.Pool;
  /** Removes all rows from all tables (and resets identity counters). */
  reset(): Promise<void>;
  /** Closes the pool and drops the database. */
  close(): Promise<void>;
}

// Quotes an identifier; the names come from our own catalogue queries and generated names
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** Creates an empty database next to the one from `DATABASE_URL` and applies all migrations. */
export async function createTestDatabase(
  baseUrl: string = process.env.DATABASE_URL ?? DEV_DATABASE_URL,
): Promise<TestDatabase> {
  const name = `humanmsg_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${quote(name)}`);
  } finally {
    await admin.end();
  }

  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  const pool = createPool(url.toString());
  // `close` drops the database with FORCE, which can cut an idle connection before the pool has
  // finished closing it; without a handler that error would crash the whole test run
  pool.on('error', () => {});
  const db = createDb(pool);
  await runMigrations(db);

  return {
    db,
    pool,
    async reset() {
      const { rows } = await pool.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
      );
      if (rows.length === 0) return;
      const tables = rows.map((row) => `public.${quote(row.tablename)}`).join(', ');
      await pool.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
    },
    async close() {
      await pool.end();
      const cleanup = new pg.Client({ connectionString: baseUrl });
      await cleanup.connect();
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}
