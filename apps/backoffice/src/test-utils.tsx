import {
  DEFAULT_SETTINGS,
  settingsSchema,
  type AdminQuestionDto,
  type AdminUserDto,
  type HistoryItemDto,
  type Settings,
  type StateResponse,
} from '@human-msg/shared';
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

export const makeQuestion = (overrides: Partial<AdminQuestionDto> = {}): AdminQuestionDto => ({
  id: '10000000-0000-4000-8000-000000000001',
  text: 'Как дела?',
  status: 'queued',
  authorId: '00000000-0000-4000-8000-000000000001',
  authorAlias: 'Зелёный Кролик',
  createdAt: '2026-10-10T10:00:00.000Z',
  expiresAt: '2026-10-10T13:00:00.000Z',
  answeredAt: null,
  answer: null,
  assignments: [],
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
    /** Newest first, as the server lists them. */
    questions: [] as AdminQuestionDto[],
    settings: { ...DEFAULT_SETTINGS } as Settings,
    /** What each test user sees (`GET /test-users/:id/state`); idle when absent. */
    testStates: {} as Record<string, StateResponse>,
    /** The refusal the next message of a test user gets, if any. */
    messageError: null as { status: number; error: string } | null,
    /** History pages of a user, in the order the cursor walks them. */
    history: {} as Record<string, HistoryItemDto[][]>,
  };

  const route = async (
    method: string,
    path: string,
    query: URLSearchParams,
    body:
      | {
          login?: string;
          password?: string;
          text?: string;
          locale?: 'ru' | 'en';
          receivingEnabled?: boolean;
        }
      | undefined,
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
    if (path === '/admin/api/questions') {
      const limit = Number(query.get('limit') ?? 20);
      const offset = Number(query.get('offset') ?? 0);
      const items = state.questions.filter(
        (question) =>
          (!query.has('status') || question.status === query.get('status')) &&
          (!query.has('authorId') || question.authorId === query.get('authorId')),
      );
      return json({ items: items.slice(offset, offset + limit), total: items.length });
    }
    if (path === '/admin/api/test-users' && method === 'POST') {
      const user = makeUser({
        id: `00000000-0000-4000-8000-${String(state.users.length + 100).padStart(12, '0')}`,
        alias: body?.locale === 'en' ? 'Brave Otter' : 'Смелая Выдра',
        locale: body?.locale ?? 'ru',
        channel: 'telegram',
        isTest: true,
        receivingEnabled: false,
      });
      state.users.unshift(user);
      return json(user, 201);
    }
    const testUser = path.match(
      /^\/admin\/api\/test-users\/([^/]+)\/(receiving|state|messages|skip)$/,
    );
    if (testUser) {
      const [, id, action] = testUser as unknown as [string, string, string];
      const user = state.users.find((candidate) => candidate.id === id);
      if (!user) return json({ error: 'not_found' }, 404);
      const screen = state.testStates[id] ?? { assignment: null, pendingQuestion: null };
      if (action === 'state') return json(screen);
      if (action === 'receiving') {
        user.receivingEnabled = Boolean(body?.receivingEnabled);
        return json({ receivingEnabled: user.receivingEnabled });
      }
      if (action === 'skip') {
        if (!screen.assignment) return json({ error: 'no_active_assignment' }, 409);
        const questionId = screen.assignment.questionId;
        state.testStates[id] = { ...screen, assignment: null };
        return json({ questionId });
      }
      if (state.messageError) {
        return json({ error: state.messageError.error }, state.messageError.status);
      }
      if (screen.assignment) {
        state.testStates[id] = { ...screen, assignment: null };
        return json({ kind: 'answered', questionId: screen.assignment.questionId });
      }
      return json({ kind: 'asked', questionId: 'q-new', status: 'queued' });
    }
    const staffAnswer = path.match(/^\/admin\/api\/questions\/([^/]+)\/staff-answer$/);
    if (staffAnswer && method === 'POST') {
      const question = state.questions.find((candidate) => candidate.id === staffAnswer[1]);
      if (!question) return json({ error: 'not_found' }, 404);
      if (question.status !== 'expired') return json({ error: 'not_expired' }, 409);
      const text = body?.text?.trim() ?? '';
      if (text.length < 2) return json({ error: text ? 'tooShort' : 'empty' }, 400);
      question.status = 'answered';
      question.answer = {
        text,
        responderId: '00000000-0000-4000-8000-0000000000aa',
        responderAlias: 'Зелёный Кролик',
        createdAt: new Date().toISOString(),
      };
      return json({ questionId: question.id }, 201);
    }
    if (path === '/admin/api/settings' && method === 'GET') {
      return json({ settings: state.settings, defaults: DEFAULT_SETTINGS });
    }
    if (path === '/admin/api/settings' && method === 'PUT') {
      const parsed = settingsSchema.safeParse({ ...state.settings, ...(body as object) });
      if (!parsed.success) return json({ error: 'invalid', issues: [] }, 400);
      state.settings = parsed.data;
      return json({ settings: state.settings, defaults: DEFAULT_SETTINGS });
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
