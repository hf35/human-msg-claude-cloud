import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeServer, makeQuestion, makeUser, renderApp } from '../test-utils';
import { questionsOfAuthor } from './QuestionList';

afterEach(() => {
  vi.unstubAllGlobals();
});

const RABBIT = '00000000-0000-4000-8000-000000000001';
const FOX = '00000000-0000-4000-8000-000000000002';
const HEDGEHOG = '00000000-0000-4000-8000-000000000003';

const waiting = makeQuestion({
  id: '10000000-0000-4000-8000-000000000003',
  text: 'Что почитать?',
  status: 'assigned',
  createdAt: '2026-10-10T12:00:00.000Z',
  assignments: [
    {
      receiverId: HEDGEHOG,
      receiverAlias: 'Тихий Ёж',
      assignedAt: '2026-10-10T12:00:00.000Z',
      deadlineAt: '2026-10-10T12:30:00.000Z',
      endedAt: null,
      outcome: null,
    },
  ],
});
const answered = makeQuestion({
  id: '10000000-0000-4000-8000-000000000002',
  text: 'Как пережить понедельник?',
  status: 'answered',
  authorId: FOX,
  authorAlias: 'Рыжая Лиса',
  createdAt: '2026-10-10T11:00:00.000Z',
  answeredAt: '2026-10-10T11:40:00.000Z',
  answer: {
    text: 'Выспаться',
    responderId: RABBIT,
    responderAlias: 'Зелёный Кролик',
    createdAt: '2026-10-10T11:40:00.000Z',
  },
  assignments: [
    {
      receiverId: HEDGEHOG,
      receiverAlias: 'Тихий Ёж',
      assignedAt: '2026-10-10T11:00:00.000Z',
      deadlineAt: '2026-10-10T11:30:00.000Z',
      endedAt: '2026-10-10T11:05:00.000Z',
      outcome: 'skipped',
    },
    {
      receiverId: RABBIT,
      receiverAlias: 'Зелёный Кролик',
      assignedAt: '2026-10-10T11:05:00.000Z',
      deadlineAt: '2026-10-10T11:35:00.000Z',
      endedAt: '2026-10-10T11:40:00.000Z',
      outcome: 'answered',
    },
  ],
});
const expired = makeQuestion({
  id: '10000000-0000-4000-8000-000000000001',
  text: 'Есть кто живой?',
  status: 'expired',
  createdAt: '2026-10-10T08:00:00.000Z',
});

function signedIn() {
  const server = fakeServer();
  server.state.signedIn = true;
  server.state.questions = [waiting, answered, expired];
  server.state.users = [
    makeUser({ id: RABBIT, alias: 'Зелёный Кролик' }),
    makeUser({ id: FOX, alias: 'Рыжая Лиса' }),
  ];
  return server;
}

const lastQuestionsQuery = (server: ReturnType<typeof fakeServer>) =>
  server.calls.filter((call) => call.path === '/admin/api/questions').at(-1)?.query;

const rowOf = (text: string) => screen.getByText(text).closest('tr')!;

describe('questions list', () => {
  it('lists the questions with status, author and who answered', async () => {
    signedIn();
    renderApp('/questions');
    await screen.findByText('Как пережить понедельник?');
    const row = rowOf('Как пережить понедельник?');
    expect(within(row).getByText('отвечен')).toBeTruthy();
    expect(within(row).getByRole('link', { name: 'Рыжая Лиса' })).toBeTruthy();
    expect(within(row).getByRole('link', { name: 'Зелёный Кролик' })).toBeTruthy();
    expect(within(row).getByText('2')).toBeTruthy();
    expect(within(rowOf('Есть кто живой?')).getByText('без ответа')).toBeTruthy();
    expect(within(rowOf('Что почитать?')).getByText('назначен')).toBeTruthy();
  });

  it('filters by status and keeps the filter in the address', async () => {
    const server = signedIn();
    renderApp('/questions');
    await screen.findByText('Что почитать?');

    await userEvent.click(
      screen.getByText('без ответа', { selector: '.ant-segmented-item-label' }),
    );
    await waitFor(() => expect(screen.queryByText('Что почитать?')).toBeNull());
    expect(screen.getByText('Есть кто живой?')).toBeTruthy();
    expect(lastQuestionsQuery(server)).toMatchObject({ status: 'expired', offset: '0' });
    expect(window.location.search).toContain('expired');

    await userEvent.click(screen.getByText('Все', { selector: '.ant-segmented-item-label' }));
    expect(await screen.findByText('Что почитать?')).toBeTruthy();
    expect(lastQuestionsQuery(server)).not.toHaveProperty('status');
  });

  it('opens a question with its answer and the history of its assignments', async () => {
    signedIn();
    renderApp('/questions');
    await screen.findByText('Как пережить понедельник?');
    await userEvent.click(
      within(rowOf('Как пережить понедельник?')).getByRole('button', { name: /развернуть/i }),
    );

    expect(await screen.findByText('Выспаться')).toBeTruthy();
    const assignments = screen.getByText('пропустил(а)').closest('table')!;
    expect(within(assignments).getByText('Тихий Ёж')).toBeTruthy();
    expect(within(assignments).getByText('ответил(а)')).toBeTruthy();
  });

  it('shows an active assignment as waiting for the answer', async () => {
    signedIn();
    renderApp('/questions');
    await screen.findByText('Что почитать?');
    await userEvent.click(
      within(rowOf('Что почитать?')).getByRole('button', { name: /развернуть/i }),
    );
    expect(await screen.findByText('ждёт ответа')).toBeTruthy();
    expect(screen.getAllByText('Ответа нет').length).toBeGreaterThan(0);
  });

  it('shows the questions of one author, opened from the user card', async () => {
    const server = signedIn();
    renderApp(`/users/${FOX}`);
    await userEvent.click(
      await screen.findByRole('link', { name: 'Все вопросы пользователя с назначениями' }),
    );

    expect(await screen.findByText('Как пережить понедельник?')).toBeTruthy();
    expect(screen.queryByText('Что почитать?')).toBeNull();
    expect(lastQuestionsQuery(server)).toMatchObject({ authorId: FOX });
    expect(screen.getByText(/Вопросы автора: Рыжая Лиса/)).toBeTruthy();

    // Closing the tag shows everyone's questions again
    const tag = screen.getByText(/Вопросы автора/).closest('.ant-tag')!;
    await userEvent.click(tag.querySelector('.ant-tag-close-icon')!);
    expect(await screen.findByText('Что почитать?')).toBeTruthy();
    expect(lastQuestionsQuery(server)).not.toHaveProperty('authorId');
  });

  it('starts from the first page when the author filter is removed', async () => {
    const server = signedIn();
    server.state.questions = Array.from({ length: 25 }, (_, index) =>
      makeQuestion({
        id: `10000000-0000-4000-8000-0000000001${String(index).padStart(2, '0')}`,
        text: `Вопрос ${index + 1}`,
        authorId: FOX,
        authorAlias: 'Рыжая Лиса',
      }),
    );
    renderApp(`${questionsOfAuthor(FOX)}&currentPage=3&pageSize=10`);
    expect(await screen.findByText('Вопрос 21')).toBeTruthy();

    const tag = screen.getByText(/Вопросы автора/).closest('.ant-tag')!;
    await userEvent.click(tag.querySelector('.ant-tag-close-icon')!);
    expect(await screen.findByText('Вопрос 1')).toBeTruthy();
    expect(lastQuestionsQuery(server)).toEqual({ limit: '10', offset: '0' });
  });
});
