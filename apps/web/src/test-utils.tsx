import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MeResponse } from '@human-msg/shared';
import { render, type RenderResult } from '@testing-library/react';
import { vi } from 'vitest';
import { App } from './App';

export interface Call {
  method: string;
  path: string;
  body: unknown;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * A stand-in for the server: a small in-memory backend behind a stubbed `fetch`. Tests reach into
 * `state` to arrange what the server knows and read `calls` to see what the page asked for.
 */
export function fakeBackend() {
  const calls: Call[] = [];
  const state = {
    signedIn: false,
    me: {
      alias: 'Green Rabbit',
      locale: 'ru',
      awaitingAnswer: false,
      busy: false,
      cooldownUntil: null,
      questionLimit: { limit: 10, used: 0, remaining: 10 },
    } as MeResponse,
    /** Overrides: `"METHOD /path"` → response, for refusals and special answers. */
    overrides: new Map<string, () => Response>(),
  };

  const handler = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url, body });

    const override = state.overrides.get(`${method} ${url}`);
    if (override) return override();

    if (method === 'POST' && url === '/api/auth/dev') {
      state.signedIn = true;
      state.me = { ...state.me, locale: body.locale ?? 'ru' };
      return json({ alias: state.me.alias, locale: state.me.locale });
    }
    if (method === 'POST' && url === '/api/auth/logout') {
      state.signedIn = false;
      return new Response(null, { status: 204 });
    }
    if (!state.signedIn) return json({ error: 'unauthorized' }, 401);
    if (method === 'GET' && url === '/api/me') return json(state.me);
    if (method === 'PATCH' && url === '/api/me') {
      state.me = { ...state.me, locale: body.locale };
      return json(state.me);
    }
    return json({ error: 'not_found' }, 404);
  };

  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => handler(String(url), init)),
  );
  return { calls, state };
}

export function renderApp(): RenderResult {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}
