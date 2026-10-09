import { sql, type SQL } from 'drizzle-orm';
import type { CommandContext } from './context';
import { ok, type Result } from './result';

export interface StatsFilter {
  /** Only questions asked at or after this moment. */
  from?: Date;
  /** Only questions asked before this moment. */
  to?: Date;
  /** Count the questions of test users too. By default only real people are counted. */
  includeTest?: boolean;
}

export interface Stats {
  questions: {
    total: number;
    queued: number;
    assigned: number;
    answered: number;
    expired: number;
    /**
     * Expired questions among the finished ones (`answered` + `expired`), 0..1; `null` while
     * nothing has finished. This is what the time settings are tuned by. Questions still in
     * progress are left out: they have not had their chance yet.
     */
    expiredShare: number | null;
    /** Answered by the back office after they expired. */
    answeredByStaff: number;
  };
  /**
   * Average time from asking to the answer, in seconds, over the questions answered by people
   * (not by the back office, whose late answers would distort it); `null` when there are none.
   */
  averageSecondsToAnswer: number | null;
  /** How the handings of these questions ended. */
  assignments: {
    total: number;
    active: number;
    answered: number;
    skipped: number;
    timedOut: number;
    reported: number;
    undeliverable: number;
  };
  /** Complaints: pairs "author never gets questions/answers of that person" created by them. */
  complaints: number;
  /** Questions waiting for a receiver right now (not limited by the period). */
  queueSize: number;
}

/** Questions of the period; the SQL fragment is used in the `WHERE` of every metric. */
function questionScope(filter: StatsFilter): SQL {
  const parts: SQL[] = [];
  if (filter.from) parts.push(sql`q.created_at >= ${filter.from.toISOString()}::timestamptz`);
  if (filter.to) parts.push(sql`q.created_at < ${filter.to.toISOString()}::timestamptz`);
  if (!filter.includeTest) parts.push(sql`au.is_test = false`);
  return parts.length === 0 ? sql`true` : sql.join(parts, sql` AND `);
}

type Row = Record<string, number | string | null>;
const first = (result: { rows: Row[] }): Row => result.rows[0] ?? {};
const num = (value: unknown): number => Number(value ?? 0);

/** Back office: the numbers the settings are tuned by. */
export async function getStats(
  { tx }: CommandContext,
  filter: StatsFilter = {},
): Promise<Result<Stats, never>> {
  const scope = questionScope(filter);

  const byStatus = first(
    await tx.execute<Row>(sql`
      SELECT count(*)::int AS total,
        count(*) FILTER (WHERE q.status = 'queued')::int AS queued,
        count(*) FILTER (WHERE q.status = 'assigned')::int AS assigned,
        count(*) FILTER (WHERE q.status = 'answered')::int AS answered,
        count(*) FILTER (WHERE q.status = 'expired')::int AS expired
      FROM questions q JOIN users au ON au.id = q.author_id
      WHERE ${scope}`),
  );

  const answers = first(
    await tx.execute<Row>(sql`
      SELECT
        avg(extract(epoch FROM (q.answered_at - q.created_at))) FILTER (WHERE NOT r.is_staff)
          AS average_seconds,
        count(*) FILTER (WHERE r.is_staff)::int AS by_staff
      FROM questions q
      JOIN users au ON au.id = q.author_id
      JOIN answers a ON a.question_id = q.id
      JOIN users r ON r.id = a.author_id
      WHERE q.status = 'answered' AND ${scope}`),
  );

  const handed = first(
    await tx.execute<Row>(sql`
      SELECT count(*)::int AS total,
        count(*) FILTER (WHERE s.outcome IS NULL)::int AS active,
        count(*) FILTER (WHERE s.outcome = 'answered')::int AS answered,
        count(*) FILTER (WHERE s.outcome = 'skipped')::int AS skipped,
        count(*) FILTER (WHERE s.outcome = 'timed_out')::int AS timed_out,
        count(*) FILTER (WHERE s.outcome = 'reported')::int AS reported,
        count(*) FILTER (WHERE s.outcome = 'undeliverable')::int AS undeliverable
      FROM assignments s
      JOIN questions q ON q.id = s.question_id
      JOIN users au ON au.id = q.author_id
      WHERE ${scope}`),
  );

  const complaints = first(
    await tx.execute<Row>(sql`
      SELECT count(*)::int AS total
      FROM blocks b
      JOIN questions q ON q.id = b.question_id
      JOIN users au ON au.id = q.author_id
      WHERE ${scope}`),
  );

  const queue = first(
    await tx.execute<Row>(sql`
      SELECT count(*)::int AS size FROM questions q JOIN users au ON au.id = q.author_id
      WHERE q.status = 'queued' AND ${filter.includeTest ? sql`true` : sql`au.is_test = false`}`),
  );

  const answered = num(byStatus.answered);
  const expired = num(byStatus.expired);
  const finished = answered + expired;
  return ok({
    questions: {
      total: num(byStatus.total),
      queued: num(byStatus.queued),
      assigned: num(byStatus.assigned),
      answered,
      expired,
      expiredShare: finished === 0 ? null : expired / finished,
      answeredByStaff: num(answers.by_staff),
    },
    averageSecondsToAnswer:
      answers.average_seconds === null || answers.average_seconds === undefined
        ? null
        : Number(answers.average_seconds),
    assignments: {
      total: num(handed.total),
      active: num(handed.active),
      answered: num(handed.answered),
      skipped: num(handed.skipped),
      timedOut: num(handed.timed_out),
      reported: num(handed.reported),
      undeliverable: num(handed.undeliverable),
    },
    complaints: num(complaints.total),
    queueSize: num(queue.size),
  });
}
