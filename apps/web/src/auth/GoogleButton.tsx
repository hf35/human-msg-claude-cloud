import { useEffect, useRef } from 'react';

const GSI_SRC = 'https://accounts.google.com/gsi/client';

interface GoogleIdentity {
  accounts: {
    id: {
      initialize(config: {
        client_id: string;
        callback(response: { credential: string }): void;
      }): void;
      renderButton(
        element: HTMLElement,
        options: { theme: string; size: string; locale: string },
      ): void;
    };
  };
}

declare global {
  interface Window {
    google?: GoogleIdentity;
  }
}

let scriptPromise: Promise<GoogleIdentity> | undefined;

/** Loads Google Identity Services once. */
function loadGoogle(): Promise<GoogleIdentity> {
  scriptPromise ??= new Promise((resolve, reject) => {
    if (window.google) return resolve(window.google);
    const script = document.createElement('script');
    script.src = GSI_SRC;
    script.async = true;
    script.onload = () => (window.google ? resolve(window.google) : reject(new Error('no google')));
    script.onerror = () => {
      scriptPromise = undefined; // a later attempt may succeed
      reject(new Error('Google script failed to load'));
    };
    document.head.append(script);
  });
  return scriptPromise;
}

interface Props {
  clientId: string;
  locale: string;
  onCredential(idToken: string): void;
  onError(): void;
}

/** The "Sign in with Google" button; the ID token goes to `onCredential`. */
export function GoogleButton({ clientId, locale, onCredential, onError }: Props) {
  const container = useRef<HTMLDivElement>(null);
  // The latest callbacks without re-rendering the Google button on every render
  const callbacks = useRef({ onCredential, onError });
  callbacks.current = { onCredential, onError };

  useEffect(() => {
    let cancelled = false;
    loadGoogle().then(
      (google) => {
        if (cancelled || !container.current) return;
        google.accounts.id.initialize({
          client_id: clientId,
          callback: ({ credential }) => callbacks.current.onCredential(credential),
        });
        google.accounts.id.renderButton(container.current, {
          theme: 'outline',
          size: 'large',
          locale,
        });
      },
      () => !cancelled && callbacks.current.onError(),
    );
    return () => {
      cancelled = true;
    };
  }, [clientId, locale]);

  return <div ref={container} data-testid="google-button" />;
}
