import { sql } from 'drizzle-orm';
import type { CommandContext } from './context';

/** The current time of the command's clock (the database's, or the test's) as a JS date. */
export async function readNow({ tx, time }: Pick<CommandContext, 'tx' | 'time'>): Promise<Date> {
  const result = await tx.execute<{ now: Date | string }>(sql`select ${time.now()} as now`);
  // Raw queries may hand back the timestamp as text
  return new Date(result.rows[0]!.now);
}
