import { createCore } from '@human-msg/core';
import { createTestDatabase, type TestDatabase } from '@human-msg/db/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import { startServer, type RunningServer } from '../server';
import { FakeTelegram } from './fake-telegram';
import { startTelegram, type RunningTelegram } from './index';

let testDb: TestDatabase;
let telegram: FakeTelegram | undefined;
let bot: RunningTelegram | undefined;
let server: RunningServer | undefined;

beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(() => testDb.close());
afterEach(async () => {
  await bot?.stop();
  await server?.stop();
  await telegram?.stop();
  bot = server = telegram = undefined;
});

const eventually = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for: ${what}`);
};

const quietLog = { info: () => {}, error: () => {} };

async function startBot() {
  telegram = new FakeTelegram();
  const apiRoot = await telegram.start();
  bot = await startTelegram({
    token: telegram.token,
    apiRoot,
    core: createCore({ db: testDb.db }),
    log: quietLog,
  });
  return telegram;
}

describe('the bot (long polling)', () => {
  it('checks the token with getMe when it starts', async () => {
    const fake = await startBot();
    expect(fake.called('getMe')).toHaveLength(1);
  });

  it('answers /start', async () => {
    const fake = await startBot();
    fake.text({ id: 42 }, '/start');
    await eventually(() => fake.called('sendMessage').length === 1, 'the answer to /start');
    expect(fake.called('sendMessage')[0]!.params).toMatchObject({ chat_id: 42 });
    expect(String(fake.called('sendMessage')[0]!.params.text)).toContain('Привет!');
  });

  it('keeps answering several users one after another', async () => {
    const fake = await startBot();
    fake.text({ id: 1 }, '/start');
    fake.text({ id: 2 }, '/start');
    fake.text({ id: 3 }, '/start');
    await eventually(() => fake.called('sendMessage').length === 3, 'three answers');
    expect(
      fake
        .called('sendMessage')
        .map((c) => c.params.chat_id)
        .sort(),
    ).toEqual([1, 2, 3]);
  });

  it('does not repeat an update it has handled', async () => {
    const fake = await startBot();
    fake.text({ id: 7 }, '/start');
    await eventually(() => fake.called('sendMessage').length === 1, 'the first answer');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fake.called('sendMessage')).toHaveLength(1);
    // The next poll confirms the update by asking for the following offset
    const polls = fake.called('getUpdates');
    expect(polls.at(-1)!.params.offset).toBeGreaterThan(1);
  });

  it('survives a failing handler and goes on with the next update', async () => {
    const fake = await startBot();
    fake.failures.set('sendMessage', { status: 500, description: 'Internal Server Error' });
    fake.text({ id: 1 }, '/start');
    await eventually(() => fake.called('sendMessage').length >= 1, 'the failed send');
    fake.failures.delete('sendMessage');
    fake.text({ id: 2 }, '/start');
    await eventually(
      () => fake.called('sendMessage').some((c) => c.params.chat_id === 2),
      'the next answer',
    );
  });

  it('stops promptly, without waiting for the long poll to end', async () => {
    await startBot();
    const started = Date.now();
    await bot!.stop();
    bot = undefined;
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe('startup', () => {
  it('refuses a wrong token with a clear error', async () => {
    telegram = new FakeTelegram();
    const apiRoot = await telegram.start();
    await expect(
      startTelegram({
        token: '999:WRONG',
        apiRoot,
        core: createCore({ db: testDb.db }),
        log: quietLog,
      }),
    ).rejects.toThrow(/Telegram bot cannot start/);
  });

  it('a server with a bot starts, answers and stops with it', async () => {
    telegram = new FakeTelegram();
    const apiRoot = await telegram.start();
    server = await startServer(
      loadConfig({
        DATABASE_URL: testDb.pool.options.connectionString!,
        LOG_LEVEL: 'silent',
        PORT: '0',
        TELEGRAM_BOT_TOKEN: telegram.token,
        TELEGRAM_API_ROOT: apiRoot,
      }),
    );
    telegram.text({ id: 5 }, '/start');
    await eventually(() => telegram!.called('sendMessage').length === 1, 'the answer');
    const stopped = server.stop();
    server = undefined;
    await stopped;
  });

  it('a server with a wrong token does not start, and leaves nothing running', async () => {
    telegram = new FakeTelegram();
    const apiRoot = await telegram.start();
    await expect(
      startServer(
        loadConfig({
          DATABASE_URL: testDb.pool.options.connectionString!,
          LOG_LEVEL: 'silent',
          PORT: '0',
          TELEGRAM_BOT_TOKEN: '999:WRONG',
          TELEGRAM_API_ROOT: apiRoot,
        }),
      ),
    ).rejects.toThrow(/Telegram bot cannot start/);
  });

  it('a server without a token runs without the bot', async () => {
    server = await startServer(
      loadConfig({
        DATABASE_URL: testDb.pool.options.connectionString!,
        LOG_LEVEL: 'silent',
        PORT: '0',
      }),
    );
    expect(server.address).toMatch(/^http/);
  });
});
