import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { getDatabaseUrl } from './config';
import * as schema from './schema';

export type Db = ReturnType<typeof createDb>;

/** The transaction handle passed to the callback of `db.transaction`. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Creates a connection pool. The caller owns it and must `end()` it on shutdown. */
export function createPool(connectionString: string = getDatabaseUrl()): pg.Pool {
  return new pg.Pool({ connectionString });
}

/** Wraps a pool into a Drizzle client that knows the schema. */
export function createDb(pool: pg.Pool) {
  return drizzle(pool, { schema });
}
