import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

interface Call {
  method: string;
  path: string;
  body: unknown;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A stand-in for the server: one correct login and password, the session is a flag. */
function fakeServer() {
  const calls: Call[] = [];
  const state = { signedIn: false, loginStatus: 401 as number, loginError: 'invalid_credentials' };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path: url, body });
      if (url === '/admin/api/me') {
        // A real server takes a moment: the page passes through its loading state
        await new Promise((resolve) => setTimeout(resolve, 20));
        return state.signedIn ? json({ ok: true }) : json({ error: 'unauthorized' }, 401);
      }
      if (url === '/admin/api/login') {
        if (body.login === 'admin' && body.password === 'secret') {
          state.signedIn = true;
          return new Response(null, { status: 204 });
        }
        return json({ error: state.loginError }, state.loginStatus);
      }
      if (url === '/admin/api/logout') {
        state.signedIn = false;
        return new Response(null, { status: 204 });
      }
      return json({ error: 'not_found' }, 404);
    }),
  );
  return { calls, state };
}

const open = (path: string) => window.history.pushState({}, '', `/admin${path}`);

beforeEach(() => open('/'));
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sign-in', () => {
  it('sends a signed-out visitor to the sign-in page', async () => {
    fakeServer();
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Вход в бэкофис' })).toBeTruthy();
    expect(window.location.pathname).toBe('/admin/login');
  });

  it('signs in with the right login and password and shows the back office', async () => {
    const server = fakeServer();
    render(<App />);
    await userEvent.type(await screen.findByLabelText('Логин'), 'admin');
    await userEvent.type(screen.getByLabelText('Пароль'), 'secret');
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }));

    expect(await screen.findByText('Вы вошли. Разделы появятся в меню слева.')).toBeTruthy();
    expect(window.location.pathname).toBe('/admin');
    expect(server.calls).toContainEqual({
      method: 'POST',
      path: '/admin/api/login',
      body: { login: 'admin', password: 'secret' },
    });
  });

  it('keeps the visitor on the page and tells why a wrong password was refused', async () => {
    const server = fakeServer();
    render(<App />);
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
    render(<App />);
    await userEvent.type(await screen.findByLabelText('Логин'), 'admin');
    await userEvent.type(screen.getByLabelText('Пароль'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }));
    await screen.findByText('Неверный логин или пароль');

    await userEvent.clear(screen.getByLabelText('Пароль'));
    await userEvent.type(screen.getByLabelText('Пароль'), 'secret');
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }));
    expect(await screen.findByText('Вы вошли. Разделы появятся в меню слева.')).toBeTruthy();
  });

  it('tells about too many attempts', async () => {
    const server = fakeServer();
    server.state.loginStatus = 429;
    server.state.loginError = 'too_many_attempts';
    render(<App />);
    await userEvent.type(await screen.findByLabelText('Логин'), 'admin');
    await userEvent.type(screen.getByLabelText('Пароль'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }));

    expect(await screen.findByText('Слишком много попыток входа, попробуйте позже')).toBeTruthy();
  });

  it('does not ask for a password while the session is valid, and signs out', async () => {
    const server = fakeServer();
    server.state.signedIn = true;
    render(<App />);
    expect(await screen.findByText('Вы вошли. Разделы появятся в меню слева.')).toBeTruthy();

    await userEvent.click(screen.getByText('Выйти'));
    expect(await screen.findByRole('heading', { name: 'Вход в бэкофис' })).toBeTruthy();
    await waitFor(() => expect(server.state.signedIn).toBe(false));
  });
});
