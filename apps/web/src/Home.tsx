import { useQueryClient } from '@tanstack/react-query';
import type { MeResponse } from '@human-msg/shared';
import { api } from './api';
import { useI18n } from './i18n';

/** The screen of a signed-in user. The question screens are added by the following tasks. */
export function Home({ me }: { me: MeResponse }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();

  async function signOut() {
    try {
      await api.logout();
    } finally {
      // Whatever the server said, nothing of the old session may stay on the screen
      await queryClient.resetQueries();
    }
  }

  return (
    <section className="card">
      <p data-testid="who">{t.web.header.signedInAs(me.alias)}</p>
      <button type="button" onClick={() => void signOut()}>
        {t.web.header.signOut}
      </button>
    </section>
  );
}
