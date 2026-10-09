import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MeResponse, StateResponse, WsMessage } from '@human-msg/shared';
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

/** A WebSocket the test controls: nothing connects until the test says so. */
export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  // Test controls
  open() {
    this.onopen?.();
  }
  send(message: WsMessage) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  sendRaw(data: string) {
    this.onmessage?.({ data });
  }
  drop() {
    this.onclose?.();
  }
  static get last(): FakeWebSocket {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
  }
}

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
      messageMaxLength: 2000,
    } as MeResponse,
    state: { assignment: null, pendingQuestion: null } as StateResponse,
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
    if (method === 'GET' && url === '/api/state') return json(state.state);
    if (method === 'PATCH' && url === '/api/me') {
      state.me = { ...state.me, locale: body.locale };
      return json(state.me);
    }
    if (method === 'POST' && url === '/api/messages' && state.state.assignment) {
      // Whatever a busy user writes is the answer
      state.state = { ...state.state, assignment: null };
      return json({ kind: 'answered', questionId: 'q-in' });
    }
    if (method === 'POST' && (url === '/api/assignment/skip' || url === '/api/reports')) {
      state.state = { ...state.state, assignment: null };
      return json({ questionId: 'q-in' });
    }
    if (method === 'POST' && url === '/api/messages') {
      // The default server accepts the text as a new question that waits in the queue
      state.state = {
        assignment: null,
        pendingQuestion: {
          questionId: 'q-new',
          text: body.text.trim(),
          status: 'queued',
          createdAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2026-01-01T03:00:00.000Z',
        },
      };
      state.me = {
        ...state.me,
        awaitingAnswer: true,
        questionLimit: {
          ...state.me.questionLimit,
          remaining: state.me.questionLimit.remaining - 1,
        },
      };
      return json({ kind: 'asked', questionId: 'q-new', status: 'queued' });
    }
    return json({ error: 'not_found' }, 404);
  };

  FakeWebSocket.instances = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => handler(String(url), init)),
  );
  vi.stubGlobal('WebSocket', FakeWebSocket);
  return { calls, state, sockets: FakeWebSocket };
}

export function renderApp(): RenderResult {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}
