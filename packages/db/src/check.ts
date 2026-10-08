import { sql } from 'drizzle-orm';
import { createDb, createPool } from './client';

// `pnpm db:check`: proves that DATABASE_URL points to a reachable database
const pool = createPool();
try {
  const result = await createDb(pool).execute(sql`select 1 as ok`);
  console.log(`Database is reachable: ${JSON.stringify(result.rows[0])}`);
} catch (error) {
  console.error('Database check failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
