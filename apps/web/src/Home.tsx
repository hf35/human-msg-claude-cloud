import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { MeResponse } from '@human-msg/shared';
import { api } from './api';
import { AnswerCard } from './AnswerCard';
import { AskPanel } from './AskPanel';
import { History } from './History';
import { IncomingCard } from './IncomingCard';
import { useI18n } from './i18n';
import { useNewAnswers } from './useNewAnswers';
import { useRealtime } from './useRealtime';

/** The screen of a signed-in user. The question screens are added by the following tasks. */
export function Home({ me }: { me: MeResponse }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  // One line of news that is not an error of a form ("time is up", "reported"); the user closes it
  const [notice, setNotice] = useState<string | null>(null);
  const connection = useRealtime((event) => {
    if (event.type === 'assignment.expired') setNotice(t.notifications.assignmentExpired);
    if (event.type === 'question.expired') setNotice(t.notifications.questionExpired);
  });
  const state = useQuery({ queryKey: ['state'], queryFn: api.state });
  const { answers, dismissAll } = useNewAnswers(me.alias);

  async function signOut() {
    try {
      await api.logout();
    } finally {
      // Whatever the server said, nothing of the old session may stay on the screen
      await queryClient.resetQueries();
    }
  }

  const { assignment, pendingQuestion } = state.data ?? {};
  return (
    <section className="card">
      <p data-testid="who">{t.web.header.signedInAs(me.alias)}</p>
      {connection === 'reconnecting' && (
        <p role="status" className="hint">
          {t.web.connection.reconnecting}
        </p>
      )}

      {notice && (
        <p role="status" className="notice" data-testid="notice">
          {notice}{' '}
          <button type="button" onClick={() => setNotice(null)}>
            {t.web.notice.dismiss}
          </button>
        </p>
      )}

      {answers.map((item) => (
        <AnswerCard key={item.id} item={item} />
      ))}
      {answers.length > 0 && (
        <button type="button" onClick={dismissAll}>
          {t.web.notice.dismiss}
        </button>
      )}

      {assignment && <IncomingCard me={me} assignment={assignment} notify={setNotice} />}
      {state.data && !assignment && <AskPanel me={me} pendingQuestion={pendingQuestion ?? null} />}
      {state.data && assignment && pendingQuestion && (
        <p className="hint" data-testid="pending">
          {t.web.state.waiting} {pendingQuestion.text}
        </p>
      )}

      <History />

      <button type="button" onClick={() => void signOut()}>
        {t.web.header.signOut}
      </button>
    </section>
  );
}
