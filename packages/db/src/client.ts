import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { getDatabaseUrl } from './config';
import * as schema from './schema';

export type Db = ReturnType<typeof createDb>;

/** The transaction handle passed to the callback of `db.transaction`. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** A single statement running longer than this is cancelled by the database. */
export const STATEMENT_TIMEOUT_MS = 30_000;
/** A transaction left open and idle longer than this is rolled back, so it cannot hold locks. */
export const IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;

/** Creates a connection pool. The caller owns it and must `end()` it on shutdown. */
export function createPool(connectionString: string = getDatabaseUrl()): pg.Pool {
  return new pg.Pool({
    connectionString,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,
  });
}

/** Wraps a pool into a Drizzle client that knows the schema. */
export function createDb(pool: pg.Pool) {
  return drizzle(pool, { schema });
}
