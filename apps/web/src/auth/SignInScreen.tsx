import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ApiError, api } from '../api';
import { useI18n } from '../i18n';
import { GoogleButton } from './GoogleButton';

const GOOGLE_CLIENT_ID: string = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';
const TELEGRAM_BOT_URL = 'https://t.me/human_answer_rng_bot';

export function SignInScreen() {
  const { locale, t } = useI18n();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function signIn(login: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await login();
      await queryClient.invalidateQueries({ queryKey: ['me'] });
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === 'network' ? t.web.errors.network : t.web.signIn.failed,
      );
    } finally {
      setBusy(false);
    }
  }

  const onDevSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim()) void signIn(() => api.loginDev({ name, locale }));
  };

  const { how, web, telegram } = t.web.signIn;

  return (
    <div className="landing">
      <section className="hero">
        <h1>{t.web.signIn.title}</h1>
        <p className="lead">{t.web.signIn.subtitle}</p>
      </section>

      <section aria-labelledby="how-title">
        <h2 id="how-title">{how.title}</h2>
        <ol className="steps">
          <li>{how.ask}</li>
          <li>{how.route}</li>
          <li>{how.answer}</li>
        </ol>
      </section>

      <section aria-labelledby="choose-title">
        <h2 id="choose-title">{t.web.signIn.choose}</h2>
        <div className="choices">
          <div className="choice">
            <h3>{web.title}</h3>
            <p className="hint">{web.text}</p>
            {GOOGLE_CLIENT_ID ? (
              <GoogleButton
                clientId={GOOGLE_CLIENT_ID}
                locale={locale}
                onCredential={(idToken) => void signIn(() => api.loginGoogle({ idToken, locale }))}
                onError={() => setError(t.web.signIn.failed)}
              />
            ) : (
              <p className="hint">{t.web.signIn.googleUnavailable}</p>
            )}
          </div>

          <div className="choice">
            <h3>{telegram.title}</h3>
            <p className="hint">{telegram.text}</p>
            <a className="button" href={TELEGRAM_BOT_URL} target="_blank" rel="noreferrer">
              {telegram.button}
            </a>
          </div>
        </div>
      </section>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      {import.meta.env.DEV && (
        <form onSubmit={onDevSubmit} className="dev-login">
          <h2>{t.web.signIn.devTitle}</h2>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t.web.signIn.devName}
            aria-label={t.web.signIn.devName}
            maxLength={64}
          />
          <button type="submit" disabled={busy || !name.trim()}>
            {t.web.signIn.devButton}
          </button>
        </form>
      )}

      <p className="hint note">{t.web.signIn.note}</p>
    </div>
  );
}
