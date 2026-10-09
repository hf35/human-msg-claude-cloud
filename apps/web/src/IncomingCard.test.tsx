import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { StateResponse } from '@human-msg/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatCountdown } from './useCountdown';
import { fakeBackend, renderApp } from './test-utils';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

const incoming = (deadlineInMs = 25 * 60_000): StateResponse => ({
  pendingQuestion: null,
  assignment: {
    questionId: 'q-in',
    text: 'What is your favourite colour?',
    authorAlias: 'Blue Fox',
    assignedAt: new Date().toISOString(),
    deadlineAt: new Date(Date.now() + deadlineInMs).toISOString(),
  },
});

function withQuestion(deadlineInMs?: number) {
  const backend = fakeBackend();
  backend.state.signedIn = true;
  backend.state.state = incoming(deadlineInMs);
  return backend;
}

describe('the card of an incoming question', () => {
  it('shows the question, its author by alias, and the time left', async () => {
    withQuestion(25 * 60_000);
    renderApp();
    expect(await screen.findByRole('heading', { name: 'Вопрос от «Blue Fox»' })).toBeTruthy();
    expect(screen.getByTestId('incoming').textContent).toBe('What is your favourite colour?');
    expect(screen.getByTestId('countdown').textContent).toMatch(/Осталось времени: 2[45]:\d\d/);
    // The question form is replaced by the answer field
    expect(screen.queryByRole('textbox', { name: 'Задайте вопрос' })).toBeNull();
  });

  it('counts down and says when the time is up', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    withQuestion(3000);
    renderApp();
    await screen.findByTestId('countdown');
    expect(screen.getByTestId('countdown').textContent).toMatch(/0:0[23]/);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(screen.getByTestId('countdown').textContent).toBe('Время вышло');
  });

  it('sends the answer and goes back to the question form', async () => {
    const { calls } = withQuestion();
    renderApp();
    await userEvent.type(await screen.findByRole('textbox', { name: 'Напишите ответ…' }), 'Green');
    await userEvent.click(screen.getByRole('button', { name: 'Ответить' }));

    expect(await screen.findByRole('textbox', { name: 'Задайте вопрос' })).toBeTruthy();
    expect(calls).toContainEqual({
      method: 'POST',
      path: '/api/messages',
      body: { text: 'Green' },
    });
  });

  it('does not send an empty answer', async () => {
    withQuestion();
    renderApp();
    const send = await screen.findByRole('button', { name: 'Ответить' });
    expect((send as HTMLButtonElement).disabled).toBe(true);
  });

  it('explains a refused answer and keeps the text', async () => {
    const { state } = withQuestion();
    state.overrides.set(
      'POST /api/messages',
      () => new Response(JSON.stringify({ error: 'tooShort' }), { status: 400 }),
    );
    renderApp();
    await userEvent.type(await screen.findByRole('textbox', { name: 'Напишите ответ…' }), 'a');
    await userEvent.click(screen.getByRole('button', { name: 'Ответить' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Сообщение слишком короткое. Напишите хотя бы пару слов.',
    );
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('a');
  });

  it('warns when the answer arrived too late and became a new question', async () => {
    const { state } = withQuestion();
    state.overrides.set(
      'POST /api/messages',
      () => new Response(JSON.stringify({ kind: 'asked', questionId: 'q9', status: 'queued' })),
    );
    renderApp();
    await userEvent.type(await screen.findByRole('textbox', { name: 'Напишите ответ…' }), 'Late');
    await userEvent.click(screen.getByRole('button', { name: 'Ответить' }));
    expect((await screen.findByTestId('notice')).textContent).toContain(
      'Время на ответ истекло: вопрос уже передан другому человеку.',
    );
  });
});

describe('skipping', () => {
  it('skips the question and says so', async () => {
    const { calls } = withQuestion();
    renderApp();
    await userEvent.click(await screen.findByRole('button', { name: 'Пропустить' }));
    expect((await screen.findByTestId('notice')).textContent).toContain('Вопрос пропущен.');
    expect(calls.some((c) => c.path === '/api/assignment/skip')).toBe(true);
    expect(await screen.findByRole('textbox', { name: 'Задайте вопрос' })).toBeTruthy();
  });

  it('says the time is over if the question was already taken back', async () => {
    const { state } = withQuestion();
    state.overrides.set(
      'POST /api/assignment/skip',
      () => new Response(JSON.stringify({ error: 'no_active_assignment' }), { status: 409 }),
    );
    renderApp();
    await userEvent.click(await screen.findByRole('button', { name: 'Пропустить' }));
    expect((await screen.findByTestId('notice')).textContent).toContain('Время на ответ истекло');
  });
});

describe('reporting', () => {
  it('asks for confirmation, and only then sends the report', async () => {
    const { calls } = withQuestion();
    renderApp();
    await userEvent.click(await screen.findByRole('button', { name: 'Пожаловаться' }));
    expect(screen.getByRole('alertdialog').textContent).toContain(
      'Вы больше не будете получать вопросы от этого человека.',
    );
    expect(calls.some((c) => c.path === '/api/reports')).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: 'Да, пожаловаться' }));
    expect((await screen.findByTestId('notice')).textContent).toContain('Жалоба принята.');
    expect(calls).toContainEqual({
      method: 'POST',
      path: '/api/reports',
      body: { target: 'question' },
    });
  });

  it('can be cancelled', async () => {
    const { calls } = withQuestion();
    renderApp();
    await userEvent.click(await screen.findByRole('button', { name: 'Пожаловаться' }));
    await userEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(calls.some((c) => c.path === '/api/reports')).toBe(false);
    expect(screen.getByRole('button', { name: 'Пожаловаться' })).toBeTruthy();
  });
});

describe('news from the server', () => {
  it('tells that the time to answer is over and removes the card', async () => {
    const { state, sockets } = withQuestion();
    renderApp();
    await screen.findByTestId('incoming');
    act(() => sockets.last.open());

    state.state = { assignment: null, pendingQuestion: null };
    act(() =>
      sockets.last.send({
        id: 7,
        createdAt: new Date().toISOString(),
        event: { type: 'assignment.expired', questionId: 'q-in' },
      }),
    );
    expect((await screen.findByTestId('notice')).textContent).toContain(
      'Время на ответ истекло, вопрос передан другому человеку.',
    );
    await waitFor(() => expect(screen.queryByTestId('incoming')).toBeNull());

    await userEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
    expect(screen.queryByTestId('notice')).toBeNull();
  });
});

describe('formatCountdown', () => {
  it.each([
    [0, '0:00'],
    [5, '0:05'],
    [125, '2:05'],
    [1800, '30:00'],
  ])('%i → %s', (seconds, text) => {
    expect(formatCountdown(seconds)).toBe(text);
  });
});
