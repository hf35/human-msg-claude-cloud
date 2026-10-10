import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeServer, renderApp } from './test-utils';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sign-in', () => {
  it('sends a signed-out visitor to the sign-in page', async () => {
    fakeServer();
    renderApp();
    expect(await screen.findByRole('heading', { name: 'Вход в бэкофис' })).toBeTruthy();
    expect(window.location.pathname).toBe('/admin/login');
  });

  it('signs in with the right login and password and shows the back office', async () => {
    const server = fakeServer();
    renderApp();
    await userEvent.type(await screen.findByLabelText('Логин'), 'admin');
    await userEvent.type(screen.getByLabelText('Пароль'), 'secret');
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }));

    expect(await screen.findByRole('heading', { name: 'Пользователи' })).toBeTruthy();
    expect(window.location.pathname).toBe('/admin/users');
    expect(server.calls).toContainEqual({
      method: 'POST',
      path: '/admin/api/login',
      query: {},
      body: { login: 'admin', password: 'secret' },
    });
  });

  it('keeps the visitor on the page and tells why a wrong password was refused', async () => {
    const server = fakeServer();
    renderApp();
    await userEvent.type(await screen.findByLabelText('Логин'), 'admin');
    await userEvent.type(screen.getByLabelText('Пароль'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }));

    expect(await screen.findByText('Неверный логин или пароль')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Вход в бэкофис' })).toBeTruthy();
    expect(server.state.signedIn).toBe(false);
    // The login stays typed: only the password has to be corrected
    expect((screen.getByLabelText('Логин') as HTMLInputElement).value).toBe('admin');
  });

  it('signs in on a second try after a wrong password', async () => {
    fakeServer();
    renderApp();
    await userEvent.type(await screen.findByLabelText('Логин'), 'admin');
    await userEvent.type(screen.getByLabelText('Пароль'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }));
    await screen.findByText('Неверный логин или пароль');

    await userEvent.clear(screen.getByLabelText('Пароль'));
    await userEvent.type(screen.getByLabelText('Пароль'), 'secret');
    // jsdom never ends antd's animation, so the faded loading icon stays in the button's name
    await userEvent.click(screen.getByRole('button', { name: /Войти/ }));
    expect(await screen.findByRole('heading', { name: 'Пользователи' })).toBeTruthy();
  });

  it('tells about too many attempts', async () => {
    const server = fakeServer();
    server.state.loginStatus = 429;
    server.state.loginError = 'too_many_attempts';
    renderApp();
    await userEvent.type(await screen.findByLabelText('Логин'), 'admin');
    await userEvent.type(screen.getByLabelText('Пароль'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }));

    expect(await screen.findByText('Слишком много попыток входа, попробуйте позже')).toBeTruthy();
  });

  it('does not ask for a password while the session is valid, and signs out', async () => {
    const server = fakeServer();
    server.state.signedIn = true;
    renderApp();
    expect(await screen.findByRole('heading', { name: 'Пользователи' })).toBeTruthy();

    await userEvent.click(screen.getByText('Выйти'));
    expect(await screen.findByRole('heading', { name: 'Вход в бэкофис' })).toBeTruthy();
    await waitFor(() => expect(server.state.signedIn).toBe(false));
  });

  it('shows the sign-in page and tells that the server is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    renderApp();
    await userEvent.type(await screen.findByLabelText('Логин'), 'admin');
    await userEvent.type(screen.getByLabelText('Пароль'), 'secret');
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }));
    expect(await screen.findByText('Не удалось связаться с сервером')).toBeTruthy();
  });
});
