import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ApiError, api } from '../api';
import { useI18n } from '../i18n';
import { GoogleButton } from './GoogleButton';

const GOOGLE_CLIENT_ID: string = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';

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

  return (
    <section className="card">
      <h1>{t.web.signIn.title}</h1>
      <p>{t.web.signIn.subtitle}</p>

      {GOOGLE_CLIENT_ID ? (
        <>
          <p className="hint">{t.web.signIn.googleHint}</p>
          <GoogleButton
            clientId={GOOGLE_CLIENT_ID}
            locale={locale}
            onCredential={(idToken) => void signIn(() => api.loginGoogle({ idToken, locale }))}
            onError={() => setError(t.web.signIn.failed)}
          />
        </>
      ) : (
        <p className="hint">{t.web.signIn.googleUnavailable}</p>
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

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
