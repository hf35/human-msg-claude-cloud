import type { AdminUserDto, HistoryItemDto } from '@human-msg/shared';
import { render, type RenderResult } from '@testing-library/react';
import { vi } from 'vitest';
import { App } from './App';

export interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const makeUser = (overrides: Partial<AdminUserDto> = {}): AdminUserDto => ({
  id: '00000000-0000-4000-8000-000000000001',
  channel: 'web',
  alias: 'Зелёный Кролик',
  locale: 'ru',
  telegramId: null,
  isTest: false,
  isStaff: false,
  receivingEnabled: true,
  missedDeadlines: 0,
  botBlockedAt: null,
  cooldownUntil: null,
  lastSeenAt: '2026-10-09T10:00:00.000Z',
  createdAt: '2026-10-01T10:00:00.000Z',
  questionsAsked: 0,
  answersGiven: 0,
  ...overrides,
});

/**
 * A stand-in for the server: one correct login and password (`admin` / `secret`), the session
 * is a flag. Tests arrange what the server knows in `state` and read what the page asked in `calls`.
 */
export function fakeServer() {
  const calls: Call[] = [];
  const state = {
    signedIn: false,
    loginStatus: 401,
    loginError: 'invalid_credentials',
    users: [] as AdminUserDto[],
    /** History pages of a user, in the order the cursor walks them. */
    history: {} as Record<string, HistoryItemDto[][]>,
  };

  const route = async (
    method: string,
    path: string,
    query: URLSearchParams,
    body: { login?: string; password?: string } | undefined,
  ) => {
    if (path === '/admin/api/login' && method === 'POST') {
      if (body?.login === 'admin' && body?.password === 'secret') {
        state.signedIn = true;
        return new Response(null, { status: 204 });
      }
      return json({ error: state.loginError }, state.loginStatus);
    }
    if (path === '/admin/api/logout' && method === 'POST') {
      state.signedIn = false;
      return new Response(null, { status: 204 });
    }
    if (!state.signedIn) return json({ error: 'unauthorized' }, 401);
    if (path === '/admin/api/me') return json({ ok: true });

    if (path === '/admin/api/users') {
      const limit = Number(query.get('limit') ?? 20);
      const offset = Number(query.get('offset') ?? 0);
      const items = state.users.filter(
        (user) =>
          (!query.has('channel') || user.channel === query.get('channel')) &&
          (!query.has('isTest') || String(user.isTest) === query.get('isTest')) &&
          (!query.has('isStaff') || String(user.isStaff) === query.get('isStaff')) &&
          (!query.has('search') || user.alias.includes(query.get('search')!)),
      );
      return json({ items: items.slice(offset, offset + limit), total: items.length });
    }
    const history = path.match(/^\/admin\/api\/users\/([^/]+)\/history$/);
    if (history) {
      const pages = state.history[history[1]!] ?? [[]];
      const index = Number(query.get('cursor') ?? 0);
      const nextCursor = index + 1 < pages.length ? String(index + 1) : null;
      return json({ items: pages[index], nextCursor });
    }
    const user = path.match(/^\/admin\/api\/users\/([^/]+)$/);
    if (user) {
      const found = state.users.find((candidate) => candidate.id === user[1]);
      return found ? json(found) : json({ error: 'not_found' }, 404);
    }
    return json({ error: 'not_found' }, 404);
  };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const parsed = new URL(url, 'http://localhost');
      calls.push({
        method,
        path: parsed.pathname,
        query: Object.fromEntries(parsed.searchParams),
        body,
      });
      // A real server takes a moment: the page passes through its loading states
      await new Promise((resolve) => setTimeout(resolve, 20));
      return route(method, parsed.pathname, parsed.searchParams, body);
    }),
  );
  return { calls, state };
}

/** Opens the back office at `path` (under /admin). */
export function renderApp(path = '/'): RenderResult {
  window.history.pushState({}, '', `/admin${path}`);
  return render(<App />);
}
