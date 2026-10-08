import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { getDatabaseUrl } from './config';
import * as schema from './schema';

export type Db = ReturnType<typeof createDb>;

/** Creates a connection pool. The caller owns it and must `end()` it on shutdown. */
export function createPool(connectionString: string = getDatabaseUrl()): pg.Pool {
  return new pg.Pool({ connectionString });
}

/** Wraps a pool into a Drizzle client that knows the schema. */
export function createDb(pool: pg.Pool) {
  return drizzle(pool, { schema });
}
