import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeWebSocket, fakeBackend, renderApp } from './test-utils';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

const queuedState = {
  assignment: null,
  pendingQuestion: {
    questionId: 'q1',
    text: 'Anybody there?',
    status: 'queued' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T03:00:00.000Z',
  },
};

describe('Home and the WebSocket', () => {
  it('opens the socket only for a signed-in user', async () => {
    const { sockets } = fakeBackend();
    renderApp();
    await screen.findByRole('heading', { level: 1 });
    expect(sockets.instances).toHaveLength(0);
  });

  it('connects after sign-in and closes the socket on sign-out', async () => {
    const { state, sockets } = fakeBackend();
    state.signedIn = true;
    renderApp();
    await screen.findByTestId('who');
    expect(sockets.instances).toHaveLength(1);
    expect(sockets.last.url).toMatch(/\/api\/ws$/);

    screen.getByRole('button', { name: 'Выйти' }).click();
    await screen.findByRole('heading', { level: 1 });
    expect(sockets.last.closed).toBe(true);
  });

  it('shows the state the server has at the start', async () => {
    const { state } = fakeBackend();
    state.signedIn = true;
    state.state = queuedState;
    renderApp();
    expect((await screen.findByTestId('pending')).textContent).toContain('Anybody there?');
  });

  it('an event updates the screen', async () => {
    const { state, sockets } = fakeBackend();
    state.signedIn = true;
    renderApp();
    await screen.findByRole('heading', { name: 'Задайте вопрос' });
    act(() => sockets.last.open());

    // The server now has a question for the user, and says so over the socket
    state.state = {
      assignment: {
        questionId: 'q2',
        text: 'What is your favourite colour?',
        authorAlias: 'Blue Fox',
        assignedAt: '2026-01-01T00:00:00.000Z',
        deadlineAt: '2026-01-01T00:30:00.000Z',
      },
      pendingQuestion: null,
    };
    act(() =>
      sockets.last.send({
        id: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        event: {
          type: 'question.assigned',
          questionId: 'q2',
          text: 'What is your favourite colour?',
          authorAlias: 'Blue Fox',
          deadlineAt: '2026-01-01T00:30:00.000Z',
        },
      }),
    );
    expect((await screen.findByTestId('incoming')).textContent).toContain(
      'What is your favourite colour?',
    );
  });

  it('after a reconnection re-reads the state it may have missed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { state, sockets } = fakeBackend();
      state.signedIn = true;
      renderApp();
      await screen.findByRole('heading', { name: 'Задайте вопрос' });
      act(() => sockets.last.open());

      act(() => sockets.last.drop());
      expect(await screen.findByText(/переподключаемся/)).toBeTruthy();

      // While the socket was down the question was answered, and nobody could tell the page
      state.state = queuedState;
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(sockets.instances).toHaveLength(2);
      act(() => sockets.last.open());

      expect((await screen.findByTestId('pending')).textContent).toContain('Anybody there?');
      await waitFor(() => expect(screen.queryByText(/переподключаемся/)).toBeNull());
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('FakeWebSocket', () => {
  it('is the global WebSocket in these tests', () => {
    fakeBackend();
    expect(WebSocket).toBe(FakeWebSocket);
  });
});
