import { outbox, type Tx } from '@human-msg/db';
import { splitEvent, type DomainEvent } from '@human-msg/shared';
import { sql } from 'drizzle-orm';

/** Postgres channel on which the dispatcher listens (`LISTEN outbox`). */
export const OUTBOX_CHANNEL = 'outbox';

/**
 * Writes an event for a user to the outbox inside the command's transaction: it becomes visible
 * to the dispatcher only if the transaction commits. The event is validated first, so a broken
 * event fails the command instead of reaching the dispatcher.
 *
 * `pg_notify` is transactional too: Postgres delivers the notification on commit and drops it on
 * rollback, so the dispatcher wakes up exactly when there is something to deliver.
 */
export async function emit(tx: Tx, userId: string, event: DomainEvent): Promise<number> {
  const { type, payload } = splitEvent(event);
  const [row] = await tx
    .insert(outbox)
    .values({ userId, type, payload })
    .returning({ id: outbox.id });
  await tx.execute(sql`SELECT pg_notify(${OUTBOX_CHANNEL}, ${String(row!.id)})`);
  return row!.id;
}
