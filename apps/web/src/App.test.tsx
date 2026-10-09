import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

afterEach(() => vi.unstubAllGlobals());

function renderApp(response: Response | Error) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      if (response instanceof Error) throw response;
      return response;
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

describe('App', () => {
  it('shows that nobody is signed in on 401', async () => {
    renderApp(new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }));
    expect(await screen.findByText('not signed in')).toBeTruthy();
  });

  it('shows the alias of the signed-in user', async () => {
    renderApp(
      new Response(
        JSON.stringify({
          alias: 'Green Rabbit',
          locale: 'ru',
          awaitingAnswer: false,
          busy: false,
          cooldownUntil: null,
          questionLimit: { limit: 10, used: 0, remaining: 10 },
        }),
      ),
    );
    expect(await screen.findByText('signed in as Green Rabbit')).toBeTruthy();
  });

  it('shows an unreachable server', async () => {
    renderApp(new TypeError('Failed to fetch'));
    expect(await screen.findByText('server unavailable')).toBeTruthy();
  });
});
