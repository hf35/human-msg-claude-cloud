import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBackend, renderApp } from './test-utils';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

function signedIn() {
  const backend = fakeBackend();
  backend.state.signedIn = true;
  return backend;
}

const refuse = (backend: ReturnType<typeof fakeBackend>, status: number, error: string) =>
  backend.state.overrides.set(
    'POST /api/messages',
    () => new Response(JSON.stringify({ error }), { status }),
  );

describe('asking a question', () => {
  it('shows the field and the number of questions left', async () => {
    signedIn();
    renderApp();
    expect(await screen.findByRole('textbox', { name: 'Задайте вопрос' })).toBeTruthy();
    expect(screen.getByText('Вопросов на сегодня осталось: 10')).toBeTruthy();
  });

  it('does not send an empty text', async () => {
    signedIn();
    renderApp();
    const button = await screen.findByRole('button', { name: 'Отправить' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByRole('textbox'), '   ');
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('sends the question and then shows that someone is being looked for', async () => {
    const { calls } = signedIn();
    renderApp();
    await userEvent.type(await screen.findByRole('textbox'), 'What is the meaning of life?');
    await userEvent.click(screen.getByRole('button', { name: 'Отправить' }));

    expect((await screen.findByTestId('pending')).textContent).toBe('What is the meaning of life?');
    expect(screen.getByTestId('pending-status').textContent).toBe(
      'Ищем, кто ответит на ваш вопрос…',
    );
    expect(calls).toContainEqual({
      method: 'POST',
      path: '/api/messages',
      body: { text: 'What is the meaning of life?' },
    });
    // While the question waits there is nothing to type into
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('shows the status of a question that is already with someone', async () => {
    const { state } = signedIn();
    state.state = {
      assignment: null,
      pendingQuestion: {
        questionId: 'q1',
        text: 'Anybody there?',
        status: 'assigned',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-01T03:00:00.000Z',
      },
    };
    renderApp();
    expect((await screen.findByTestId('pending-status')).textContent).toBe(
      'Вопрос уже у собеседника — ждём ответа.',
    );
  });

  it('shows the pending question after a page reload (it comes from the server)', async () => {
    const { state } = signedIn();
    state.state = {
      assignment: null,
      pendingQuestion: {
        questionId: 'q1',
        text: 'Still waiting',
        status: 'queued',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-01T03:00:00.000Z',
      },
    };
    renderApp();
    expect((await screen.findByTestId('pending')).textContent).toBe('Still waiting');
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

describe('refusals are explained', () => {
  it.each([
    [
      'awaitingAnswer',
      409,
      'Вы уже задали вопрос — дождитесь ответа, прежде чем задавать следующий.',
    ],
    ['dailyLimit', 429, 'Вы достигли лимита вопросов на сегодня (10). Попробуйте позже.'],
    ['tooShort', 400, 'Сообщение слишком короткое. Напишите хотя бы пару слов.'],
    ['tooLong', 400, 'Сообщение слишком длинное. Максимум — 2000 символов.'],
  ])('%s', async (code, status, message) => {
    const backend = signedIn();
    refuse(backend, status, code);
    renderApp();
    await userEvent.type(await screen.findByRole('textbox'), 'A question for you');
    await userEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    expect((await screen.findByRole('alert')).textContent).toBe(message);
    // The text stays, so the user can fix it
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('A question for you');
  });

  it('explains it in English too', async () => {
    const backend = signedIn();
    backend.state.me = { ...backend.state.me, locale: 'en' };
    refuse(backend, 429, 'dailyLimit');
    renderApp();
    await userEvent.type(await screen.findByRole('textbox'), 'One more question');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      "You have reached today's question limit (10). Please try again later.",
    );
  });

  it('says so when the server cannot be reached', async () => {
    const backend = signedIn();
    renderApp();
    await userEvent.type(await screen.findByRole('textbox'), 'Hello out there');
    backend.state.overrides.set('POST /api/messages', () => {
      throw new TypeError('Failed to fetch');
    });
    await userEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Нет связи с сервером'),
    );
  });

  it('refreshes the picture after a refusal: the question that was already asked appears', async () => {
    const backend = signedIn();
    renderApp();
    await userEvent.type(await screen.findByRole('textbox'), 'My second try here');
    // Meanwhile the first question (from another tab) is waiting on the server
    backend.state.state = {
      assignment: null,
      pendingQuestion: {
        questionId: 'q1',
        text: 'The first one',
        status: 'queued',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-01T03:00:00.000Z',
      },
    };
    refuse(backend, 409, 'awaitingAnswer');
    await userEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    expect((await screen.findByTestId('pending')).textContent).toBe('The first one');
  });
});
