import { createDb, createPool } from './client';
import { runMigrations } from './migrate';

// `pnpm db:migrate`: brings the database in DATABASE_URL up to date
const pool = createPool();
try {
  await runMigrations(createDb(pool));
  console.log('Migrations applied');
} catch (error) {
  console.error('Migration failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
