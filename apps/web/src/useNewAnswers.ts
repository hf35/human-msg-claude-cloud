import { useQuery } from '@tanstack/react-query';
import type { HistoryResponse } from '@human-msg/shared';
import { useEffect, useState } from 'react';
import { api } from './api';

export type AnsweredQuestion = Extract<HistoryResponse['items'][number], { kind: 'question' }> & {
  answer: NonNullable<Extract<HistoryResponse['items'][number], { kind: 'question' }>['answer']>;
};

const EPOCH = '1970-01-01T00:00:00.000Z';
const storageKey = (alias: string) => `answers-seen:${alias}`;

function readSeen(alias: string): string | null {
  try {
    return localStorage.getItem(storageKey(alias));
  } catch {
    return null;
  }
}

function writeSeen(alias: string, value: string): void {
  try {
    localStorage.setItem(storageKey(alias), value);
  } catch {
    // Without storage the cards come back after a reload, which is better than losing an answer
  }
}

/**
 * Answers the user has not looked at yet, newest first. They come from the server's history (so
 * an answer that arrived while the page was closed is still there), and "seen" is the server
 * time of the newest answer the user closed: no comparison with this device's clock.
 *
 * A browser that has never seen the user starts clean: the answers that exist at that moment
 * count as seen, they are in the history.
 */
export function useNewAnswers(alias: string) {
  const history = useQuery({
    queryKey: ['history', 'latest'],
    queryFn: () => api.history({ limit: 10 }),
  });
  const [seen, setSeen] = useState<string | null>(() => readSeen(alias));

  const answered = (history.data?.items ?? []).filter(
    (item): item is AnsweredQuestion => item.kind === 'question' && item.answer !== null,
  );
  const newest = answered.reduce(
    (max, item) => (item.answer.createdAt > max ? item.answer.createdAt : max),
    EPOCH,
  );

  // First visit from this browser: everything that exists now is old news
  useEffect(() => {
    if (seen === null && history.data) {
      writeSeen(alias, newest);
      setSeen(newest);
    }
  }, [alias, seen, history.data, newest]);

  const fresh = seen === null ? [] : answered.filter((item) => item.answer.createdAt > seen);

  return {
    answers: fresh.sort((a, b) => (a.answer.createdAt < b.answer.createdAt ? 1 : -1)),
    /** Marks the answers shown now as seen. */
    dismissAll() {
      if (fresh.length === 0) return;
      const latest = fresh.reduce(
        (max, item) => (item.answer.createdAt > max ? item.answer.createdAt : max),
        seen ?? EPOCH,
      );
      writeSeen(alias, latest);
      setSeen(latest);
    },
  };
}
