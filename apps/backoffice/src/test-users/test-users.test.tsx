import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeServer, makeUser, renderApp } from '../test-utils';

afterEach(() => {
  vi.unstubAllGlobals();
});

const ASKER = '00000000-0000-4000-8000-000000000011';
const RECEIVER = '00000000-0000-4000-8000-000000000012';

function signedIn() {
  const server = fakeServer();
  server.state.signedIn = true;
  server.state.users = [
    makeUser({ id: RECEIVER, alias: 'Тихий Ёж', isTest: true, receivingEnabled: true }),
    makeUser({ id: ASKER, alias: 'Смелый Барсук', isTest: true, receivingEnabled: false }),
    makeUser({ alias: 'Живой Человек' }),
  ];
  server.state.testStates[RECEIVER] = {
    assignment: {
      questionId: 'q1',
      text: 'Какой ваш любимый звук?',
      authorAlias: 'Смелый Барсук',
      assignedAt: '2026-10-10T10:00:00.000Z',
      deadlineAt: '2026-10-10T10:30:00.000Z',
    },
    pendingQuestion: null,
  };
  server.state.testStates[ASKER] = {
    assignment: null,
    pendingQuestion: {
      questionId: 'q1',
      text: 'Какой ваш любимый звук?',
      status: 'assigned',
      createdAt: '2026-10-10T10:00:00.000Z',
      expiresAt: '2026-10-10T13:00:00.000Z',
    },
  };
  return server;
}

/** The card of a test user, found by the alias in its title. */
const card = (alias: string) =>
  screen.getByRole('link', { name: alias }).closest('.ant-card') as HTMLElement;

const callsTo = (server: ReturnType<typeof fakeServer>, path: string) =>
  server.calls.filter((call) => call.path === path);

describe('test users', () => {
  it('shows only test users, each with what they see on their screen', async () => {
    const server = signedIn();
    renderApp('/test-users');
    await screen.findByRole('link', { name: 'Тихий Ёж' });
    expect(screen.queryByText('Живой Человек')).toBeNull();
    expect(callsTo(server, '/admin/api/users').at(-1)?.query).toMatchObject({ isTest: 'true' });

    const receiver = card('Тихий Ёж');
    expect(await within(receiver).findByText('Вопрос от Смелый Барсук')).toBeTruthy();
    expect(within(receiver).getByRole('button', { name: 'Ответить' })).toBeTruthy();
    expect(within(receiver).getByRole('button', { name: 'Пропустить' })).toBeTruthy();

    const asker = card('Смелый Барсук');
    expect(await within(asker).findByText('Свой вопрос')).toBeTruthy();
    expect(within(asker).getByText('назначен')).toBeTruthy();
    expect(within(asker).getByRole('button', { name: 'Спросить' })).toBeTruthy();
  });

  it('switches the availability of a test user', async () => {
    const server = signedIn();
    renderApp('/test-users');
    await userEvent.click(await screen.findByRole('switch', { name: 'Доступен: Смелый Барсук' }));
    await waitFor(() =>
      expect(callsTo(server, `/admin/api/test-users/${ASKER}/receiving`).at(-1)?.body).toEqual({
        receivingEnabled: true,
      }),
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole('switch', { name: 'Доступен: Смелый Барсук' })
          .getAttribute('aria-checked'),
      ).toBe('true'),
    );
  });

  it('answers the assigned question with the message', async () => {
    const server = signedIn();
    renderApp('/test-users');
    await screen.findByRole('link', { name: 'Тихий Ёж' });
    const receiver = card('Тихий Ёж');
    await within(receiver).findByText('Вопрос от Смелый Барсук');
    await userEvent.type(within(receiver).getByRole('textbox'), 'Шум дождя');
    await userEvent.click(within(receiver).getByRole('button', { name: 'Ответить' }));

    expect(await screen.findByText('Ответ отправлен')).toBeTruthy();
    expect(callsTo(server, `/admin/api/test-users/${RECEIVER}/messages`).at(-1)?.body).toEqual({
      text: 'Шум дождя',
    });
    await waitFor(() => expect(within(receiver).queryByText('Вопрос от Смелый Барсук')).toBeNull());
  });

  it('skips the assigned question', async () => {
    const server = signedIn();
    renderApp('/test-users');
    await screen.findByRole('link', { name: 'Тихий Ёж' });
    const receiver = card('Тихий Ёж');
    await userEvent.click(await within(receiver).findByRole('button', { name: 'Пропустить' }));
    expect(await screen.findByText('Вопрос пропущен')).toBeTruthy();
    expect(callsTo(server, `/admin/api/test-users/${RECEIVER}/skip`)).toHaveLength(1);
    await waitFor(() =>
      expect(within(receiver).getByRole('button', { name: 'Спросить' })).toBeTruthy(),
    );
  });

  it('asks a question and tells when it waits in the queue', async () => {
    const server = signedIn();
    server.state.testStates[ASKER] = { assignment: null, pendingQuestion: null };
    renderApp('/test-users');
    await screen.findByRole('link', { name: 'Смелый Барсук' });
    const asker = card('Смелый Барсук');
    await within(asker).findByText('Нет ни назначенного вопроса, ни своего вопроса без ответа');
    await userEvent.type(within(asker).getByRole('textbox'), 'Что почитать?');
    await userEvent.click(within(asker).getByRole('button', { name: 'Спросить' }));
    expect(await screen.findByText('Вопрос в очереди: свободного получателя нет')).toBeTruthy();
    expect(callsTo(server, `/admin/api/test-users/${ASKER}/messages`)).toHaveLength(1);
  });

  it('tells why a question is refused', async () => {
    const server = signedIn();
    server.state.messageError = { status: 409, error: 'awaitingAnswer' };
    renderApp('/test-users');
    await screen.findByRole('link', { name: 'Смелый Барсук' });
    const asker = card('Смелый Барсук');
    await userEvent.type(within(asker).getByRole('textbox'), 'Второй вопрос');
    await userEvent.click(within(asker).getByRole('button', { name: 'Спросить' }));
    expect(
      await screen.findByText('Пользователь ждёт ответа на свой вопрос: новый задать нельзя'),
    ).toBeTruthy();
  });

  it('checks the text before sending it', async () => {
    const server = signedIn();
    renderApp('/test-users');
    await screen.findByRole('link', { name: 'Смелый Барсук' });
    const asker = card('Смелый Барсук');
    await userEvent.click(within(asker).getByRole('button', { name: 'Спросить' }));
    expect(await within(asker).findByText('Пустой текст')).toBeTruthy();
    expect(callsTo(server, `/admin/api/test-users/${ASKER}/messages`)).toHaveLength(0);
  });

  it('creates a test user in the chosen language', async () => {
    const server = signedIn();
    renderApp('/test-users');
    await screen.findByRole('link', { name: 'Тихий Ёж' });
    await userEvent.click(screen.getByRole('combobox', { name: 'Язык нового пользователя' }));
    await userEvent.click(await screen.findByTitle('English'));
    await userEvent.click(screen.getByRole('button', { name: 'Создать' }));

    expect(await screen.findByText('Создан тестовый пользователь: Brave Otter')).toBeTruthy();
    expect(callsTo(server, '/admin/api/test-users').at(-1)?.body).toEqual({ locale: 'en' });
    expect(await screen.findByRole('link', { name: 'Brave Otter' })).toBeTruthy();
  });
});
