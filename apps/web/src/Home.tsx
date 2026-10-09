import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { MeResponse } from '@human-msg/shared';
import { api } from './api';
import { useI18n } from './i18n';
import { useRealtime } from './useRealtime';

/** The screen of a signed-in user. The question screens are added by the following tasks. */
export function Home({ me }: { me: MeResponse }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const connection = useRealtime();
  const state = useQuery({ queryKey: ['state'], queryFn: api.state });

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

      {/* Plain placeholders: the real cards come with the next tasks */}
      {assignment && (
        <p data-testid="incoming">
          {t.web.state.incoming} {assignment.text}
        </p>
      )}
      {pendingQuestion && (
        <p data-testid="pending">
          {t.web.state.waiting} {pendingQuestion.text}
        </p>
      )}
      {state.data && !assignment && !pendingQuestion && <p className="hint">{t.web.state.idle}</p>}

      <button type="button" onClick={() => void signOut()}>
        {t.web.header.signOut}
      </button>
    </section>
  );
}
