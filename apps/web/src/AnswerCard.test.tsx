import { act, screen, waitFor } from '@testing-library/react';
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
const answered = (id: string, question: string, answer: string, at: string): Item => ({
  kind: 'question',
  id,
  questionId: id,
  text: question,
  status: 'answered',
  createdAt: '2026-01-01T00:00:00.000Z',
  answer: { text: answer, responderAlias: 'Blue Fox', createdAt: at },
});

function signedIn(items: Item[] = []) {
  const backend = fakeBackend();
  backend.state.signedIn = true;
  backend.state.history = { items, nextCursor: null };
  return backend;
}

describe('a received answer', () => {
  it('is shown together with the question it answers', async () => {
    const backend = signedIn();
    renderApp();
    await screen.findByRole('textbox', { name: 'Задайте вопрос' });

    // The answer arrives while the page is open: the author has since asked something else
    backend.state.history = {
      items: [answered('q1', 'What colour is the sky?', 'Blue.', '2026-01-01T05:00:00.000Z')],
      nextCursor: null,
    };
    act(() => backend.sockets.last.open());
    act(() =>
      backend.sockets.last.send({
        id: 1,
        createdAt: '2026-01-01T05:00:00.000Z',
        event: {
          type: 'answer.received',
          questionId: 'q1',
          questionText: 'What colour is the sky?',
          answerText: 'Blue.',
          responderAlias: 'Blue Fox',
        },
      }),
    );

    expect(await screen.findByRole('heading', { name: 'Ответ от «Blue Fox»' })).toBeTruthy();
    expect(screen.getByTestId('answer-question').textContent).toBe('What colour is the sky?');
    expect(screen.getByTestId('answer-text').textContent).toBe('Blue.');
  });

  it('is shown after a reload if it came while the page was closed', async () => {
    // This browser has already seen the user, and the answer is newer than what it saw
    localStorage.setItem('answers-seen:Green Rabbit', '2026-01-01T01:00:00.000Z');
    signedIn([answered('q1', 'Old question?', 'Late answer.', '2026-01-01T05:00:00.000Z')]);
    renderApp();
    expect((await screen.findByTestId('answer-text')).textContent).toBe('Late answer.');
  });

  it('does not show old answers on the first visit from this browser', async () => {
    signedIn([answered('q1', 'Old question?', 'Old answer.', '2026-01-01T05:00:00.000Z')]);
    renderApp();
    await screen.findByRole('textbox', { name: 'Задайте вопрос' });
    await waitFor(() => expect(localStorage.getItem('answers-seen:Green Rabbit')).not.toBeNull());
    expect(screen.queryByTestId('answer-card')).toBeNull();
  });

  it('shows several unseen answers, newest first, each with its own question', async () => {
    localStorage.setItem('answers-seen:Green Rabbit', '2026-01-01T00:30:00.000Z');
    signedIn([
      answered('q1', 'First?', 'One.', '2026-01-01T01:00:00.000Z'),
      answered('q2', 'Second?', 'Two.', '2026-01-01T02:00:00.000Z'),
    ]);
    renderApp();
    await screen.findAllByTestId('answer-card');
    expect(screen.getAllByTestId('answer-question').map((e) => e.textContent)).toEqual([
      'Second?',
      'First?',
    ]);
  });

  it('is gone for good once closed', async () => {
    localStorage.setItem('answers-seen:Green Rabbit', '2026-01-01T00:30:00.000Z');
    signedIn([answered('q1', 'First?', 'One.', '2026-01-01T01:00:00.000Z')]);
    const view = renderApp();
    await userEvent.click(await screen.findByRole('button', { name: 'Закрыть' }));
    expect(screen.queryByTestId('answer-card')).toBeNull();
    expect(localStorage.getItem('answers-seen:Green Rabbit')).toBe('2026-01-01T01:00:00.000Z');

    view.unmount();
    renderApp();
    await screen.findByRole('textbox', { name: 'Задайте вопрос' });
    expect(screen.queryByTestId('answer-card')).toBeNull();
  });

  it('is a separate matter for each user of the same browser', async () => {
    localStorage.setItem('answers-seen:Somebody Else', '2026-01-01T09:00:00.000Z');
    signedIn([answered('q1', 'First?', 'One.', '2026-01-01T01:00:00.000Z')]);
    renderApp();
    await screen.findByRole('textbox', { name: 'Задайте вопрос' });
    // Green Rabbit has no record yet: the existing answer is old news for them too
    expect(screen.queryByTestId('answer-card')).toBeNull();
  });
});

describe('reporting an answer', () => {
  const setup = () => {
    localStorage.setItem('answers-seen:Green Rabbit', '2026-01-01T00:30:00.000Z');
    return signedIn([answered('q1', 'First?', 'Rude answer.', '2026-01-01T01:00:00.000Z')]);
  };

  it('asks for confirmation, then reports the answer by its question', async () => {
    const { calls } = setup();
    renderApp();
    await userEvent.click(await screen.findByRole('button', { name: 'Пожаловаться' }));
    expect(screen.getByRole('alertdialog').textContent).toContain(
      'Вы больше не получите ответов от этого человека.',
    );
    expect(calls.some((c) => c.path === '/api/reports')).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: 'Да, пожаловаться' }));
    expect(
      await screen.findByText('Жалоба принята. Вы больше не получите ответов от этого человека.'),
    ).toBeTruthy();
    expect(calls).toContainEqual({
      method: 'POST',
      path: '/api/reports',
      body: { target: 'answer', questionId: 'q1' },
    });
  });

  it('can be cancelled', async () => {
    const { calls } = setup();
    renderApp();
    await userEvent.click(await screen.findByRole('button', { name: 'Пожаловаться' }));
    await userEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(calls.some((c) => c.path === '/api/reports')).toBe(false);
  });

  it('shows a failure', async () => {
    const backend = setup();
    backend.state.overrides.set('POST /api/reports', () => new Response('{}', { status: 500 }));
    renderApp();
    await userEvent.click(await screen.findByRole('button', { name: 'Пожаловаться' }));
    await userEvent.click(screen.getByRole('button', { name: 'Да, пожаловаться' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Что-то пошло не так. Попробуйте ещё раз чуть позже.',
    );
  });
});
