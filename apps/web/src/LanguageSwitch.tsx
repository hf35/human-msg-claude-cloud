import { LOCALES } from '@human-msg/shared';
import { useI18n } from './i18n';

/** Two buttons, RU and EN; the same codes in every language, so they never need translating. */
export function LanguageSwitch() {
  const { locale, setLocale, t } = useI18n();
  return (
    <div role="group" aria-label={t.web.header.language} className="language-switch">
      {LOCALES.map((code) => (
        <button
          key={code}
          type="button"
          aria-pressed={code === locale}
          onClick={() => code !== locale && setLocale(code)}
        >
          {code.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
