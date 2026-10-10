import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeServer, makeQuestion, renderApp } from '../test-utils';

afterEach(() => {
  vi.unstubAllGlobals();
});

const lonely = makeQuestion({
  id: '10000000-0000-4000-8000-000000000001',
  text: 'Есть кто живой?',
  status: 'expired',
});
const forgotten = makeQuestion({
  id: '10000000-0000-4000-8000-000000000002',
  text: 'Что приготовить на ужин?',
  status: 'expired',
  authorAlias: 'Рыжая Лиса',
});

function signedIn() {
  const server = fakeServer();
  server.state.signedIn = true;
  // Copies: the fake server changes the questions it answers
  server.state.questions = structuredClone([lonely, forgotten]);
  return server;
}

const answerButtonOf = (text: string) =>
  within(screen.getByText(text).closest('tr')!).getByRole('button', { name: 'Ответить' });

const dialog = () => screen.getByRole('dialog');

describe('journal of unanswered questions', () => {
  it('lists only the expired questions', async () => {
    const server = signedIn();
    renderApp('/expired');
    expect(await screen.findByText('Есть кто живой?')).toBeTruthy();
    expect(screen.getByText('Что приготовить на ужин?')).toBeTruthy();
    const calls = server.calls.filter((call) => call.path === '/admin/api/questions');
    expect(calls.every((call) => call.query.status === 'expired')).toBe(true);
  });

  it('answers a question: the answer goes to the server and the question leaves the journal', async () => {
    const server = signedIn();
    renderApp('/expired');
    await screen.findByText('Есть кто живой?');
    await userEvent.click(answerButtonOf('Есть кто живой?'));
    await userEvent.type(within(dialog()).getByLabelText('Ответ'), '  Да, я здесь!  ');
    await userEvent.click(within(dialog()).getByRole('button', { name: /Отправить ответ/ }));

    expect(await screen.findByText('Ответ отправлен автору')).toBeTruthy();
    expect(server.calls).toContainEqual(
      expect.objectContaining({
        method: 'POST',
        path: `/admin/api/questions/${lonely.id}/staff-answer`,
        body: { text: '  Да, я здесь!  ' },
      }),
    );
    await waitFor(() => expect(screen.queryByText('Есть кто живой?')).toBeNull());
    expect(screen.getByText('Что приготовить на ужин?')).toBeTruthy();
  });

  it('checks the text like any message before sending it', async () => {
    const server = signedIn();
    renderApp('/expired');
    await screen.findByText('Есть кто живой?');
    await userEvent.click(answerButtonOf('Есть кто живой?'));

    await userEvent.click(within(dialog()).getByRole('button', { name: /Отправить ответ/ }));
    expect(await within(dialog()).findByText('Напишите ответ')).toBeTruthy();
    await userEvent.type(within(dialog()).getByLabelText('Ответ'), 'Д');
    expect(await within(dialog()).findByText('Ответ слишком короткий')).toBeTruthy();
    expect(server.calls.some((call) => call.path.endsWith('/staff-answer'))).toBe(false);
  });

  it('limits the answer to the length from the settings', async () => {
    const server = signedIn();
    server.state.settings.MESSAGE_MAX_LENGTH = 50;
    renderApp('/expired');
    await screen.findByText('Есть кто живой?');
    await userEvent.click(answerButtonOf('Есть кто живой?'));
    expect(await within(dialog()).findByText('0 / 50')).toBeTruthy();

    // A longer text is not cut: it is refused with a reason
    const long = 'Очень длинный ответ, который не помещается в лимит настроек.';
    await userEvent.click(within(dialog()).getByLabelText('Ответ'));
    await userEvent.paste(long);
    expect((within(dialog()).getByLabelText('Ответ') as HTMLTextAreaElement).value).toBe(long);
    expect(await within(dialog()).findByText('Ответ слишком длинный')).toBeTruthy();
    await userEvent.click(within(dialog()).getByRole('button', { name: /Отправить ответ/ }));
    expect(server.calls.some((call) => call.path.endsWith('/staff-answer'))).toBe(false);
  });

  it('counts an emoji as one character', async () => {
    signedIn();
    renderApp('/expired');
    await screen.findByText('Есть кто живой?');
    await userEvent.click(answerButtonOf('Есть кто живой?'));
    await userEvent.click(within(dialog()).getByLabelText('Ответ'));
    await userEvent.paste('Да 👍🏽');
    expect(await within(dialog()).findByText('4 / 2000')).toBeTruthy();
  });

  it('tells when someone has already answered and drops the question from the journal', async () => {
    const server = signedIn();
    renderApp('/expired');
    await screen.findByText('Есть кто живой?');
    await userEvent.click(answerButtonOf('Есть кто живой?'));
    // Answered in another tab meanwhile
    server.state.questions[0]!.status = 'answered';
    await userEvent.type(within(dialog()).getByLabelText('Ответ'), 'Да, я здесь!');
    await userEvent.click(within(dialog()).getByRole('button', { name: /Отправить ответ/ }));

    expect(await screen.findByText('На этот вопрос уже ответили')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Есть кто живой?')).toBeNull());
    expect(server.state.questions[0]!.answer).toBeNull();
  });
});
