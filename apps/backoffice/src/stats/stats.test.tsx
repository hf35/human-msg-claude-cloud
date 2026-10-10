import type { AdminStatsDto } from '@human-msg/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeServer, renderApp } from '../test-utils';
import { formatDuration } from './StatsPage';

afterEach(() => {
  vi.unstubAllGlobals();
});

const STATS: AdminStatsDto = {
  questions: {
    total: 40,
    queued: 2,
    assigned: 3,
    answered: 30,
    expired: 5,
    expiredShare: 5 / 35,
    answeredByStaff: 4,
  },
  averageSecondsToAnswer: 3900,
  assignments: {
    total: 60,
    active: 3,
    answered: 26,
    skipped: 20,
    timedOut: 9,
    reported: 1,
    undeliverable: 1,
  },
  complaints: 2,
  queueSize: 2,
};

function signedIn(stats: AdminStatsDto = STATS) {
  const server = fakeServer();
  server.state.signedIn = true;
  server.state.stats = stats;
  return server;
}

const statsQueries = (server: ReturnType<typeof fakeServer>) =>
  server.calls.filter((call) => call.path === '/admin/api/stats').map((call) => call.query);

/** The value of the statistic with this title. */
const value = (title: string) => {
  const heading = [...document.querySelectorAll('.ant-statistic-title')].find(
    (element) => element.textContent === title,
  );
  if (!heading) throw new Error(`No statistic "${title}"`);
  return heading.closest('.ant-statistic')!.querySelector('.ant-statistic-content')!.textContent;
};

describe('statistics', () => {
  it('shows the share of unanswered questions, time to answer, queue and complaints', async () => {
    signedIn();
    renderApp('/stats');
    await screen.findByText('Среднее время до ответа');
    expect(value('Доля без ответа')).toBe('14.3%');
    expect(screen.getByText('5 / 35')).toBeTruthy();
    expect(value('Среднее время до ответа')).toBe('1 ч 5 мин');
    expect(value('В очереди сейчас')).toBe('2');
    expect(value('Жалобы')).toBe('2');
    expect(value('Отвечено из бэкофиса')).toBe('4');
    expect(screen.getByRole('progressbar', { name: 'Пропустили' }).textContent).toContain('20');
  });

  it('asks for the last week of live users by default, then as chosen', async () => {
    const server = signedIn();
    renderApp('/stats');
    await screen.findByText('Среднее время до ответа');
    const first = statsQueries(server)[0]!;
    expect(first).not.toHaveProperty('includeTest');
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(Date.parse(first.from!) - weekAgo)).toBeLessThan(60_000);

    await userEvent.click(screen.getByRole('switch', { name: 'Учитывать тестовых' }));
    await waitFor(() => expect(statsQueries(server).at(-1)).toMatchObject({ includeTest: 'true' }));

    await userEvent.click(screen.getByText('Всё время'));
    await waitFor(() => expect(statsQueries(server).at(-1)).toEqual({ includeTest: 'true' }));
  });

  it('shows a dash while nothing has finished', async () => {
    signedIn({
      ...STATS,
      questions: { ...STATS.questions, answered: 0, expired: 0, expiredShare: null },
      averageSecondsToAnswer: null,
    });
    renderApp('/stats');
    await screen.findByText('Среднее время до ответа');
    expect(value('Доля без ответа')).toBe('—');
    expect(value('Среднее время до ответа')).toBe('—');
  });
});

describe('formatDuration', () => {
  it('reads like a person would say it', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(40)).toBe('40 с');
    expect(formatDuration(12 * 60 + 20)).toBe('12 мин');
    expect(formatDuration(3 * 3600)).toBe('3 ч 0 мин');
  });
});
