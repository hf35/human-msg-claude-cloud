import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from './client';

// Needs the PostgreSQL from docker-compose.yml (and from the CI service)
const pool = createPool(
  process.env.DATABASE_URL ?? 'postgres://humanmsg:humanmsg@localhost:5432/humanmsg',
);

afterAll(() => pool.end());

describe('database client', () => {
  it('runs a query', async () => {
    const result = await createDb(pool).execute(sql`select 1 as ok`);
    expect(result.rows).toEqual([{ ok: 1 }]);
  });
});
