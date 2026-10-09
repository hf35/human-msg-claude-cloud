import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Locale } from '@human-msg/shared';
import { useEffect, useState } from 'react';
import { ApiError, api } from './api';
import { SignInScreen } from './auth/SignInScreen';
import { Home } from './Home';
import { I18nProvider, initialLocale, storeLocale, textsFor } from './i18n';
import { LanguageSwitch } from './LanguageSwitch';

export function App() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const [chosen, setChosen] = useState<Locale>(initialLocale);

  // A signed-in user's language is the one stored in their profile; before that, the choice
  // made on this device
  const locale = me.data?.locale ?? chosen;
  const t = textsFor(locale);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const saveLocale = useMutation({
    mutationFn: api.updateMe,
    onSuccess: (updated) => queryClient.setQueryData(['me'], updated),
  });
  const setLocale = (next: Locale) => {
    storeLocale(next);
    setChosen(next);
    if (me.data) saveLocale.mutate({ locale: next });
  };

  const signedOut = me.error instanceof ApiError && me.error.status === 401;

  return (
    <I18nProvider value={{ locale, t, setLocale }}>
      <header className="top">
        <strong>human-msg</strong>
        <LanguageSwitch />
      </header>
      <main>
        {me.isPending && <p>{t.web.errors.loading}</p>}
        {signedOut && <SignInScreen />}
        {me.isError && !signedOut && (
          <p role="alert" className="error">
            {t.web.errors.network}
          </p>
        )}
        {me.data && <Home me={me.data} />}
      </main>
    </I18nProvider>
  );
}
