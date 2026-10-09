import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from './api';
import { formatDateTime } from './format';
import { useI18n } from './i18n';

/** The user's own history: questions they asked (with answers) and answers they gave. */
export function History() {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);

  const history = useInfiniteQuery({
    queryKey: ['history', 'list'],
    queryFn: ({ pageParam }) => api.history({ limit: 20, ...(pageParam && { cursor: pageParam }) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // Nothing is fetched until the user asks to see it
    enabled: open,
  });
  const items = history.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section className="card history">
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? t.web.history.hide : t.web.history.show}
      </button>

      {open && (
        <>
          <h2>{t.web.history.title}</h2>
          {history.isPending && <p>{t.web.errors.loading}</p>}
          {history.isError && (
            <p role="alert" className="error">
              {t.web.errors.network}
            </p>
          )}
          {history.data && items.length === 0 && <p className="hint">{t.web.history.empty}</p>}

          <ul>
            {items.map((item) =>
              item.kind === 'question' ? (
                <li key={item.id} data-testid="history-question">
                  <p className="hint">
                    {t.web.history.asked} · {formatDateTime(item.createdAt, locale)} ·{' '}
                    {t.web.history.status[item.status]}
                  </p>
                  <blockquote>{item.text}</blockquote>
                  {item.answer && (
                    <>
                      <p className="hint">{t.web.history.answerFrom(item.answer.responderAlias)}</p>
                      <blockquote data-testid="history-answer">{item.answer.text}</blockquote>
                    </>
                  )}
                </li>
              ) : (
                <li key={item.id} data-testid="history-given">
                  <p className="hint">
                    {t.web.history.youAnswered(item.authorAlias)} ·{' '}
                    {formatDateTime(item.createdAt, locale)}
                  </p>
                  <p className="hint">{t.web.history.theirQuestion}</p>
                  <blockquote>{item.questionText}</blockquote>
                  <p className="hint">{t.web.history.yourAnswer}</p>
                  <blockquote>{item.text}</blockquote>
                </li>
              ),
            )}
          </ul>

          {history.hasNextPage && (
            <button
              type="button"
              disabled={history.isFetchingNextPage}
              onClick={() => void history.fetchNextPage()}
            >
              {t.web.history.loadMore}
            </button>
          )}
        </>
      )}
    </section>
  );
}
