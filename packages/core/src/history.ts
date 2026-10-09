import { answers, questions, users } from '@human-msg/db';
import { aliasedTable, and, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { CommandContext } from './context';
import { fail, ok, type Result } from './result';

export const HISTORY_DEFAULT_LIMIT = 20;
export const HISTORY_MAX_LIMIT = 50;

/** A question the user asked, with the answer if there is one. */
export interface HistoryQuestion {
  kind: 'question';
  /** Id of the question; also the id of the item. */
  id: string;
  questionId: string;
  text: string;
  status: 'queued' | 'assigned' | 'answered' | 'expired';
  createdAt: Date;
  answer: { text: string; responderAlias: string; createdAt: Date } | null;
}

/** An answer the user gave to somebody's question. */
export interface HistoryAnswer {
  kind: 'answer';
  /** Id of the answer; also the id of the item. */
  id: string;
  questionId: string;
  /** The text of the user's answer. */
  text: string;
  questionText: string;
  authorAlias: string;
  createdAt: Date;
}

export type HistoryItem = HistoryQuestion | HistoryAnswer;

export interface HistoryPage {
  items: HistoryItem[];
  /** Pass it as `cursor` to get the next page; `null` on the last page. */
  nextCursor: string | null;
}

interface Position {
  /** Microseconds since the epoch: the cursor must not lose the precision of the database time. */
  micros: bigint;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const encodeCursor = ({ micros, id }: Position) =>
  Buffer.from(`${micros}|${id}`).toString('base64url');

function decodeCursor(cursor: string): Position | null {
  const [micros, id, extra] = Buffer.from(cursor, 'base64url').toString().split('|');
  if (extra !== undefined || !micros || !id || !/^\d{1,18}$/.test(micros) || !UUID.test(id)) {
    return null;
  }
  return { micros: BigInt(micros), id };
}

const microsOf = (column: AnyPgColumn) =>
  sql<string>`(extract(epoch from ${column}) * 1000000)::bigint::text`;

/** `(created_at, id) < cursor`, computed in the database so no precision is lost. */
const before = (createdAt: AnyPgColumn, id: AnyPgColumn, p?: Position): SQL | undefined =>
  p
    ? sql`(${createdAt}, ${id}) < (timestamptz 'epoch' + ${p.micros.toString()}::bigint * interval '1 microsecond', ${p.id}::uuid)`
    : undefined;

/**
 * The user's own history, newest first: questions they asked (with the answers) and answers they
 * gave, merged into one feed. Paged by a keyset cursor, so a new item appearing meanwhile does
 * not shift the pages.
 */
export async function getHistory(
  ctx: CommandContext,
  userId: string,
  options: { limit?: number; cursor?: string } = {},
): Promise<Result<HistoryPage, 'invalid_cursor'>> {
  const limit = Math.min(Math.max(options.limit ?? HISTORY_DEFAULT_LIMIT, 1), HISTORY_MAX_LIMIT);
  let position: Position | undefined;
  if (options.cursor !== undefined) {
    const decoded = decodeCursor(options.cursor);
    if (!decoded) return fail('invalid_cursor');
    position = decoded;
  }
  const { tx } = ctx;
  const responders = aliasedTable(users, 'responders');
  const authors = aliasedTable(users, 'authors');

  // Each source gives `limit + 1` items after the cursor: the best `limit` of both are the page,
  // and a surplus item shows that there is a next page
  const asked = await tx
    .select({
      id: questions.id,
      text: questions.text,
      status: questions.status,
      createdAt: questions.createdAt,
      micros: microsOf(questions.createdAt),
      answerText: answers.text,
      answerCreatedAt: answers.createdAt,
      responderAlias: responders.alias,
    })
    .from(questions)
    .leftJoin(answers, eq(answers.questionId, questions.id))
    .leftJoin(responders, eq(responders.id, answers.authorId))
    .where(and(eq(questions.authorId, userId), before(questions.createdAt, questions.id, position)))
    .orderBy(desc(questions.createdAt), desc(questions.id))
    .limit(limit + 1);

  const given = await tx
    .select({
      id: answers.id,
      questionId: answers.questionId,
      text: answers.text,
      createdAt: answers.createdAt,
      micros: microsOf(answers.createdAt),
      questionText: questions.text,
      authorAlias: authors.alias,
    })
    .from(answers)
    .innerJoin(questions, eq(questions.id, answers.questionId))
    .innerJoin(authors, eq(authors.id, questions.authorId))
    .where(and(eq(answers.authorId, userId), before(answers.createdAt, answers.id, position)))
    .orderBy(desc(answers.createdAt), desc(answers.id))
    .limit(limit + 1);

  const merged: Array<{ item: HistoryItem; position: Position }> = [
    ...asked.map((row) => ({
      position: { micros: BigInt(row.micros), id: row.id },
      item: {
        kind: 'question' as const,
        id: row.id,
        questionId: row.id,
        text: row.text,
        status: row.status,
        createdAt: row.createdAt,
        answer:
          row.answerText !== null && row.answerCreatedAt !== null && row.responderAlias !== null
            ? {
                text: row.answerText,
                responderAlias: row.responderAlias,
                createdAt: row.answerCreatedAt,
              }
            : null,
      },
    })),
    ...given.map((row) => ({
      position: { micros: BigInt(row.micros), id: row.id },
      item: {
        kind: 'answer' as const,
        id: row.id,
        questionId: row.questionId,
        text: row.text,
        questionText: row.questionText,
        authorAlias: row.authorAlias,
        createdAt: row.createdAt,
      },
    })),
  ];
  // Newest first; the id breaks ties exactly like the database does (uuid order = hex order)
  merged.sort((a, b) =>
    a.position.micros !== b.position.micros
      ? a.position.micros > b.position.micros
        ? -1
        : 1
      : a.position.id > b.position.id
        ? -1
        : 1,
  );

  const page = merged.slice(0, limit);
  const last = page[page.length - 1];
  const hasMore = merged.length > limit;
  return ok({
    items: page.map((entry) => entry.item),
    nextCursor: hasMore && last ? encodeCursor(last.position) : null,
  });
}
