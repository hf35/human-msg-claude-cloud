import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeServer, makeUser, renderApp } from '../test-utils';

afterEach(() => {
  vi.unstubAllGlobals();
});

const rabbit = makeUser({
  id: '00000000-0000-4000-8000-000000000001',
  alias: 'Зелёный Кролик',
  questionsAsked: 2,
  answersGiven: 1,
});
const fox = makeUser({
  id: '00000000-0000-4000-8000-000000000002',
  alias: 'Рыжая Лиса',
  channel: 'telegram',
  telegramId: 4242,
  receivingEnabled: false,
});
const tester = makeUser({
  id: '00000000-0000-4000-8000-000000000003',
  alias: 'Тихий Ёж',
  isTest: true,
});

function signedIn() {
  const server = fakeServer();
  server.state.signedIn = true;
  server.state.users = [rabbit, fox, tester];
  return server;
}

const lastUsersQuery = (server: ReturnType<typeof fakeServer>) =>
  server.calls.filter((call) => call.path === '/admin/api/users').at(-1)?.query;

describe('users list', () => {
  it('lists the users with their channel, kind and whether they receive questions', async () => {
    signedIn();
    renderApp('/users');
    const row = (await screen.findByText('Рыжая Лиса')).closest('tr')!;
    expect(within(row).getByText('Telegram')).toBeTruthy();
    expect(within(row).getByText('Живой')).toBeTruthy();
    expect(within(row).getByText('не беспокоить')).toBeTruthy();
    const testRow = screen.getByText('Тихий Ёж').closest('tr')!;
    expect(within(testRow).getByText('Тестовый')).toBeTruthy();
  });

  it('opens on the users list after sign-in', async () => {
    signedIn();
    renderApp('/');
    expect(await screen.findByText('Зелёный Кролик')).toBeTruthy();
    expect(window.location.pathname).toBe('/admin/users');
  });

  it('sends the filters to the server', async () => {
    const server = signedIn();
    renderApp('/users');
    await screen.findByText('Зелёный Кролик');

    await userEvent.click(screen.getByRole('combobox', { name: 'Тип' }));
    await userEvent.click(await screen.findByTitle('Тестовый'));
    await userEvent.type(screen.getByPlaceholderText('Поиск по псевдониму'), 'Ёж');
    await userEvent.click(screen.getByRole('button', { name: 'Найти' }));

    await waitFor(() =>
      expect(lastUsersQuery(server)).toMatchObject({
        isTest: 'true',
        isStaff: 'false',
        search: 'Ёж',
      }),
    );
    await waitFor(() => expect(screen.queryByText('Зелёный Кролик')).toBeNull());
    expect(screen.getByText('Тихий Ёж')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Сбросить' }));
    await waitFor(() => expect(lastUsersQuery(server)).toEqual({ limit: '10', offset: '0' }));
    expect(await screen.findByText('Зелёный Кролик')).toBeTruthy();
  });
});

describe('user card', () => {
  it('shows the user and their conversation, page by page', async () => {
    const server = signedIn();
    server.state.history[rabbit.id] = [
      [
        {
          kind: 'question',
          id: 'q2',
          questionId: 'q2',
          text: 'Что почитать?',
          status: 'queued',
          createdAt: '2026-10-09T12:00:00.000Z',
          answer: null,
        },
        {
          kind: 'answer',
          id: 'a1',
          questionId: 'q9',
          text: 'Выспаться',
          questionText: 'Как пережить понедельник?',
          authorAlias: 'Рыжая Лиса',
          createdAt: '2026-10-08T12:00:00.000Z',
        },
      ],
      [
        {
          kind: 'question',
          id: 'q1',
          questionId: 'q1',
          text: 'Как дела?',
          status: 'answered',
          createdAt: '2026-10-07T12:00:00.000Z',
          answer: {
            text: 'Отлично',
            responderAlias: 'Тихий Ёж',
            createdAt: '2026-10-07T12:30:00.000Z',
          },
        },
      ],
    ];
    renderApp('/users');
    await userEvent.click(await screen.findByRole('link', { name: 'Зелёный Кролик' }));

    expect(await screen.findByText('Что почитать?')).toBeTruthy();
    expect(window.location.pathname).toBe(`/admin/users/${rabbit.id}`);
    expect(screen.getByText('Ответа нет')).toBeTruthy();
    expect(screen.getByText('Как пережить понедельник?')).toBeTruthy();
    expect(screen.getByText('Вопрос от Рыжая Лиса')).toBeTruthy();
    expect(screen.getByText('Выспаться')).toBeTruthy();
    expect(screen.queryByText('Как дела?')).toBeNull();
    // Refine's stock buttons are named by the resource, not by a translation key
    expect(screen.getByRole('button', { name: /Пользователи/ })).toBeTruthy();
    expect(screen.queryByText(/titles/)).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Показать ещё' }));
    expect(await screen.findByText('Как дела?')).toBeTruthy();
    expect(screen.getByText('Отлично')).toBeTruthy();
    expect(screen.getByText(/Ответ от Тихий Ёж/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Показать ещё' })).toBeNull();
    expect(server.calls.at(-1)?.query).toEqual({ limit: '20', cursor: '1' });
  });

  it('shows the Telegram id of a Telegram user', async () => {
    signedIn();
    renderApp(`/users/${fox.id}`);
    expect(await screen.findByText('4242')).toBeTruthy();
    expect(
      await screen.findByText('Пользователь ещё ничего не спрашивал и не отвечал'),
    ).toBeTruthy();
  });

  it('tells that an unknown user does not exist', async () => {
    signedIn();
    renderApp('/users/00000000-0000-4000-8000-00000000ffff');
    expect(await screen.findAllByText('Не найдено')).toBeTruthy();
  });
});

describe('users filters in the address', () => {
  it('restores the search form from the address after a reload', async () => {
    const server = signedIn();
    renderApp(
      '/users?filters[0][field]=isTest&filters[0][operator]=eq&filters[0][value]=true' +
        '&filters[1][field]=search&filters[1][operator]=eq&filters[1][value]=Ёж',
    );
    expect(await screen.findByText('Тихий Ёж')).toBeTruthy();
    expect(screen.queryByText('Зелёный Кролик')).toBeNull();
    expect(lastUsersQuery(server)).toMatchObject({ isTest: 'true', search: 'Ёж' });
    expect((screen.getByPlaceholderText('Поиск по псевдониму') as HTMLInputElement).value).toBe(
      'Ёж',
    );
    expect(screen.getByTitle('Тестовый')).toBeTruthy();
  });

  it('shows the date pickers in Russian', async () => {
    signedIn();
    renderApp('/users');
    expect(await screen.findByPlaceholderText('Начальная дата')).toBeTruthy();
  });
});
