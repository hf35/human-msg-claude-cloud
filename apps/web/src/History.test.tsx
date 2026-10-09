import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { HistoryResponse } from '@human-msg/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBackend, renderApp } from './test-utils';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

type Item = HistoryResponse['items'][number];
const asked = (
  id: string,
  text: string,
  status: 'queued' | 'assigned' | 'answered' | 'expired',
  answer: string | null,
): Item => ({
  kind: 'question',
  id,
  questionId: id,
  text,
  status,
  createdAt: '2026-03-04T10:05:00.000Z',
  answer: answer
    ? { text: answer, responderAlias: 'Blue Fox', createdAt: '2026-03-04T11:00:00.000Z' }
    : null,
});
const given: Item = {
  kind: 'answer',
  id: 'a1',
  questionId: 'q9',
  text: 'Because it is round.',
  questionText: 'Why is the moon a ball?',
  authorAlias: 'Red Owl',
  createdAt: '2026-03-04T09:00:00.000Z',
};

function signedIn() {
  const backend = fakeBackend();
  backend.state.signedIn = true;
  // Everything on the first page is old news for this browser
  localStorage.setItem('answers-seen:Green Rabbit', '2999-01-01T00:00:00.000Z');
  return backend;
}

const openHistory = async () =>
  userEvent.click(await screen.findByRole('button', { name: 'Показать историю' }));

describe('history', () => {
  it('stays closed and does not load anything until asked', async () => {
    const { calls } = signedIn();
    renderApp();
    await screen.findByRole('button', { name: 'Показать историю' });
    expect(screen.queryByRole('heading', { name: 'История' })).toBeNull();
    expect(calls.filter((c) => c.path.includes('limit=20'))).toHaveLength(0);
  });

  it('says so when there is nothing yet', async () => {
    signedIn();
    renderApp();
    await openHistory();
    expect(await screen.findByText('Здесь появятся ваши вопросы и ответы.')).toBeTruthy();
  });

  it('shows my questions with their answers and my own answers', async () => {
    const { state } = signedIn();
    state.history = {
      items: [
        asked('q1', 'What colour is the sky?', 'answered', 'Blue.'),
        asked('q2', 'Anyone home?', 'expired', null),
        given,
      ],
      nextCursor: null,
    };
    renderApp();
    await openHistory();

    const questions = await screen.findAllByTestId('history-question');
    expect(questions).toHaveLength(2);
    expect(within(questions[0]!).getByText('What colour is the sky?')).toBeTruthy();
    expect(within(questions[0]!).getByTestId('history-answer').textContent).toBe('Blue.');
    expect(within(questions[0]!).getByText(/Есть ответ/)).toBeTruthy();
    expect(within(questions[0]!).getByText('Ответ от «Blue Fox»')).toBeTruthy();
    // A question nobody answered shows its state and no answer
    expect(within(questions[1]!).getByText(/Никто не успел ответить/)).toBeTruthy();
    expect(within(questions[1]!).queryByTestId('history-answer')).toBeNull();

    const mine = screen.getByTestId('history-given');
    expect(within(mine).getByText(/Вы ответили на вопрос от «Red Owl»/)).toBeTruthy();
    expect(within(mine).getByText('Why is the moon a ball?')).toBeTruthy();
    expect(within(mine).getByText('Because it is round.')).toBeTruthy();
  });

  it('formats times in the language of the user', async () => {
    const { state } = signedIn();
    state.me = { ...state.me, locale: 'en' };
    state.history = { items: [asked('q1', 'Hello?', 'queued', null)], nextCursor: null };
    renderApp();
    await userEvent.click(await screen.findByRole('button', { name: 'Show history' }));
    expect((await screen.findByTestId('history-question')).textContent).toMatch(/Mar 4, 2026/);
    expect(screen.getByText(/Looking for someone to answer/)).toBeTruthy();
  });

  it('loads further pages on request and appends them', async () => {
    const { state, calls } = signedIn();
    state.historyPages = [
      { items: [asked('q3', 'Newest', 'queued', null)], nextCursor: '1' },
      { items: [asked('q2', 'Older', 'expired', null)], nextCursor: '2' },
      { items: [asked('q1', 'Oldest', 'expired', null)], nextCursor: null },
    ];
    renderApp();
    await openHistory();
    expect(await screen.findByText('Newest')).toBeTruthy();
    expect(screen.queryByText('Older')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Показать ещё' }));
    expect(await screen.findByText('Older')).toBeTruthy();
    expect(screen.getByText('Newest')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Показать ещё' }));
    expect(await screen.findByText('Oldest')).toBeTruthy();
    // The last page has no "more" button
    expect(screen.queryByRole('button', { name: 'Показать ещё' })).toBeNull();
    expect(calls.some((c) => c.path.includes('cursor=2'))).toBe(true);
  });

  it('can be hidden again', async () => {
    signedIn();
    renderApp();
    await openHistory();
    await userEvent.click(await screen.findByRole('button', { name: 'Скрыть историю' }));
    expect(screen.queryByRole('heading', { name: 'История' })).toBeNull();
  });

  it('shows a failure', async () => {
    const { state } = signedIn();
    state.overrides.set('GET /api/history?limit=20', () => new Response('{}', { status: 500 }));
    renderApp();
    await openHistory();
    expect((await screen.findByRole('alert')).textContent).toContain('Нет связи с сервером');
  });
});
