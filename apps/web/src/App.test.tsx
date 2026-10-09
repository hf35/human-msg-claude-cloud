import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBackend, renderApp } from './test-utils';

beforeEach(() => {
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['ru-RU']);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('signed out', () => {
  it('shows the sign-in screen in the language of the browser', async () => {
    fakeBackend();
    renderApp();
    expect(await screen.findByRole('heading', { name: 'Спросите живого человека' })).toBeTruthy();
    expect(document.documentElement.lang).toBe('ru');
  });

  it('uses English for an English browser', async () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en-GB']);
    fakeBackend();
    renderApp();
    expect(await screen.findByRole('heading', { name: 'Ask a real person' })).toBeTruthy();
    expect(document.documentElement.lang).toBe('en');
  });

  it('switches the language and remembers it for the next visit', async () => {
    fakeBackend();
    const view = renderApp();
    await screen.findByRole('heading', { name: 'Спросите живого человека' });
    await userEvent.click(screen.getByRole('button', { name: 'EN' }));
    expect(await screen.findByRole('heading', { name: 'Ask a real person' })).toBeTruthy();
    expect(localStorage.getItem('locale')).toBe('en');

    view.unmount();
    renderApp();
    expect(await screen.findByRole('heading', { name: 'Ask a real person' })).toBeTruthy();
  });

  it('tells that Google sign-in is not configured', async () => {
    fakeBackend();
    renderApp();
    expect(await screen.findByText('Вход через Google не настроен на этом сервере.')).toBeTruthy();
  });
});

describe('development sign-in', () => {
  it('signs in with a name and sends the current language', async () => {
    const { calls } = fakeBackend();
    renderApp();
    await userEvent.click(await screen.findByRole('button', { name: 'EN' }));
    await userEvent.type(await screen.findByLabelText('Name of the test user'), 'alice');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in without Google' }));

    expect(await screen.findByTestId('who')).toBeTruthy();
    expect(calls).toContainEqual({
      method: 'POST',
      path: '/api/auth/dev',
      body: { name: 'alice', locale: 'en' },
    });
    expect(screen.getByTestId('who').textContent).toBe('You are "Green Rabbit"');
  });

  it('does not submit an empty name', async () => {
    fakeBackend();
    renderApp();
    const button = await screen.findByRole('button', { name: 'Войти без Google' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows a readable error when the sign-in fails', async () => {
    const { state } = fakeBackend();
    state.overrides.set('POST /api/auth/dev', () => new Response('{}', { status: 500 }));
    renderApp();
    await userEvent.type(await screen.findByLabelText('Имя тестового пользователя'), 'alice');
    await userEvent.click(screen.getByRole('button', { name: 'Войти без Google' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Не удалось войти. Попробуйте ещё раз.',
    );
  });
});

describe('signed in', () => {
  it('shows the user right away when the session is alive (page reload)', async () => {
    const { state } = fakeBackend();
    state.signedIn = true;
    renderApp();
    expect((await screen.findByTestId('who')).textContent).toBe('Вы — «Green Rabbit»');
  });

  it('takes the language from the profile', async () => {
    const { state } = fakeBackend();
    state.signedIn = true;
    state.me = { ...state.me, locale: 'en' };
    renderApp();
    expect((await screen.findByTestId('who')).textContent).toBe('You are "Green Rabbit"');
  });

  it('saves a language switch in the profile', async () => {
    const { state, calls } = fakeBackend();
    state.signedIn = true;
    renderApp();
    await screen.findByTestId('who');
    await userEvent.click(screen.getByRole('button', { name: 'EN' }));
    await waitFor(() =>
      expect(screen.getByTestId('who').textContent).toBe('You are "Green Rabbit"'),
    );
    expect(calls).toContainEqual({ method: 'PATCH', path: '/api/me', body: { locale: 'en' } });
    expect(state.me.locale).toBe('en');
  });

  it('signs out and returns to the sign-in screen', async () => {
    const { state, calls } = fakeBackend();
    state.signedIn = true;
    renderApp();
    await userEvent.click(await screen.findByRole('button', { name: 'Выйти' }));
    expect(await screen.findByRole('heading', { name: 'Спросите живого человека' })).toBeTruthy();
    expect(calls.some((c) => c.path === '/api/auth/logout')).toBe(true);
    expect(screen.queryByTestId('who')).toBeNull();
  });
});

describe('server trouble', () => {
  it('says that the server is unreachable', async () => {
    fakeBackend();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    renderApp();
    expect((await screen.findByRole('alert')).textContent).toContain('Нет связи с сервером');
  });
});
