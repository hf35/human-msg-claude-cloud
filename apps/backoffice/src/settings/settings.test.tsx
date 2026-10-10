import { DEFAULT_SETTINGS } from '@human-msg/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeServer, renderApp } from '../test-utils';

afterEach(() => {
  vi.unstubAllGlobals();
});

function signedIn() {
  const server = fakeServer();
  server.state.signedIn = true;
  server.state.settings = { ...DEFAULT_SETTINGS, ANSWER_TIMEOUT: 20 * 60, QUESTIONS_PER_DAY: 7 };
  return server;
}

const field = (label: string) => screen.getByLabelText(label, { exact: true }) as HTMLInputElement;
const puts = (server: ReturnType<typeof fakeServer>) =>
  server.calls.filter((call) => call.path === '/admin/api/settings' && call.method === 'PUT');

async function replace(label: string, value: string) {
  await userEvent.clear(field(label));
  await userEvent.type(field(label), value);
}

describe('settings', () => {
  it('shows the settings in force, durations in minutes, with their defaults', async () => {
    signedIn();
    renderApp('/settings');
    await waitFor(() => expect(field('Время на ответ').value).toBe('20'));
    expect(field('Время жизни вопроса').value).toBe('180');
    expect(field('Вопросов в сутки').value).toBe('7');
    expect(field('Тихие часы').value).toBe('23:00-09:00');
    const timeout = field('Время на ответ').closest('.ant-form-item') as HTMLElement;
    expect(within(timeout).getByText('По умолчанию: 30 мин')).toBeTruthy();
  });

  it('sends only what changed, durations in seconds', async () => {
    const server = signedIn();
    renderApp('/settings');
    await waitFor(() => expect(field('Время на ответ').value).toBe('20'));
    await replace('Время на ответ', '45');
    await replace('Тихие часы', '22:30-08:00');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    expect(await screen.findByText('Настройки сохранены')).toBeTruthy();
    expect(puts(server).at(-1)?.body).toEqual({ ANSWER_TIMEOUT: 2700, QUIET_HOURS: '22:30-08:00' });
    expect(server.state.settings.ANSWER_TIMEOUT).toBe(2700);
  });

  it('puts a default back with one click', async () => {
    const server = signedIn();
    renderApp('/settings');
    await waitFor(() => expect(field('Вопросов в сутки').value).toBe('7'));
    const limit = field('Вопросов в сутки').closest('.ant-form-item') as HTMLElement;
    await userEvent.click(within(limit).getByText('вернуть'));
    expect(field('Вопросов в сутки').value).toBe('10');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await screen.findByText('Настройки сохранены');
    expect(puts(server).at(-1)?.body).toEqual({ QUESTIONS_PER_DAY: 10 });
  });

  it('says so when nothing changed', async () => {
    const server = signedIn();
    renderApp('/settings');
    await waitFor(() => expect(field('Время на ответ').value).toBe('20'));
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('Ничего не изменено')).toBeTruthy();
    expect(puts(server)).toHaveLength(0);
  });

  it('refuses a reminder that does not come before the deadline', async () => {
    const server = signedIn();
    renderApp('/settings');
    await waitFor(() => expect(field('Время на ответ').value).toBe('20'));
    await replace('Время на ответ', '5');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(
      await screen.findByText('Напоминание должно быть раньше дедлайна: меньше времени на ответ'),
    ).toBeTruthy();
    expect(puts(server)).toHaveLength(0);
  });

  it('refuses quiet hours in a wrong format', async () => {
    const server = signedIn();
    renderApp('/settings');
    await waitFor(() => expect(field('Тихие часы').value).toBe('23:00-09:00'));
    await replace('Тихие часы', '23-9');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('Формат ЧЧ:ММ-ЧЧ:ММ, например 23:00-09:00')).toBeTruthy();
    expect(puts(server)).toHaveLength(0);
  });

  it('drops unsaved edits', async () => {
    signedIn();
    renderApp('/settings');
    await waitFor(() => expect(field('Время на ответ').value).toBe('20'));
    await replace('Время на ответ', '45');
    await userEvent.click(screen.getByRole('button', { name: 'Отменить изменения' }));
    expect(field('Время на ответ').value).toBe('20');
  });
});
