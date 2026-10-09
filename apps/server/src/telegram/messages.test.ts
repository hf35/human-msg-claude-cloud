import { createCore, createSettingsStore, type Core, type SettingsStore } from '@human-msg/core';
import { answers, assignments, blocks, outbox, questions, users } from '@human-msg/db';
import { createTestDatabase, type TestDatabase } from '@human-msg/db/testing';
import { getTexts } from '@human-msg/shared';
import Fastify from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dispatchOnce } from '../delivery/dispatcher';
import { FakeTelegram } from './fake-telegram';
import { startTelegram, WEBHOOK_PATH, type RunningTelegram } from './index';

let testDb: TestDatabase;
let fake: FakeTelegram | undefined;
let bot: RunningTelegram | undefined;
let core: Core;
let settings: SettingsStore;

beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(() => testDb.close());
beforeEach(() => testDb.reset());
afterEach(async () => {
  await bot?.stop();
  await fake?.stop();
  bot = fake = undefined;
});

const log = { info: () => {}, error: () => {} };

async function start() {
  fake = new FakeTelegram();
  const apiRoot = await fake.start();
  settings = createSettingsStore({ db: testDb.db, cacheMs: 0 });
  core = createCore({ db: testDb.db, settings });
  bot = await startTelegram({ token: fake.token, apiRoot, core, log });
  return fake;
}

const until = async (check: () => boolean | Promise<boolean>, what: string) => {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for: ${what}`);
};

/** One pass of the dispatcher with the bot's adapter, as the server does. */
const deliver = () =>
  dispatchOnce({ core, adapters: { telegram: bot!.adapter }, onFailure: () => {} });

const sentTo = (f: FakeTelegram, id: number) =>
  f.called('sendMessage').filter((call) => call.params.chat_id === id);
const userOf = async (telegramId: number) =>
  (await testDb.db.select().from(users)).find((user) => user.telegramId === telegramId)!;

const ru = (id: number) => ({ id, language_code: 'ru' });
const en = (id: number) => ({ id, language_code: 'en' });

/** Registers a person with /start and waits until the account exists. */
async function join(f: FakeTelegram, from: { id: number; language_code?: string }) {
  f.text(from, '/start');
  await until(() => sentTo(f, from.id).length > 0, `greeting of ${from.id}`);
}

/** `author` asks `question`; with `receiver` registered first, the question goes to them. */
async function ask(f: FakeTelegram, author: { id: number }, question: string) {
  f.text(author, question);
  await until(async () => (await testDb.db.select().from(questions)).length > 0, 'the question');
}

describe('incoming text', () => {
  it('registers a stranger and queues their question', async () => {
    const f = await start();
    f.text(ru(100), 'Как жить?');
    await until(async () => (await testDb.db.select().from(questions)).length === 1, 'question');

    expect((await testDb.db.select().from(questions))[0]).toMatchObject({ status: 'queued' });
    await deliver();
    expect(sentTo(f, 100).map((c) => c.params.text)).toEqual([
      getTexts('ru').notifications.questionQueued,
    ]);
  });

  it('hands a question to an available person and takes their reply as the answer', async () => {
    const f = await start();
    await join(f, en(201));
    await join(f, ru(202));
    await ask(f, en(201), 'Is the sky blue?');
    await deliver();

    const received = sentTo(f, 202).at(-1)!.params;
    expect(String(received.text)).toContain('Is the sky blue?');
    expect(received.reply_markup).toMatchObject({
      inline_keyboard: [[{ callback_data: expect.stringMatching(/^skip:/) }, expect.anything()]],
    });

    f.text(ru(202), 'Yes, mostly');
    await until(async () => (await testDb.db.select().from(answers)).length === 1, 'the answer');
    await deliver();

    const back = sentTo(f, 201).at(-1)!.params;
    expect(String(back.text)).toContain('Is the sky blue?');
    expect(String(back.text)).toContain('Yes, mostly');
    expect(back.reply_markup).toMatchObject({
      inline_keyboard: [[{ callback_data: expect.stringMatching(/^ra:/) }]],
    });
  });

  it('refuses anything but text', async () => {
    const f = await start();
    await join(f, ru(300));
    f.photo(ru(300));
    await until(async () => (await testDb.db.select().from(outbox)).length === 1, 'rejection');
    await deliver();
    expect(sentTo(f, 300).at(-1)!.params.text).toBe(getTexts('ru').rejections.onlyText);
    expect(await testDb.db.select().from(questions)).toHaveLength(0);
  });

  it('refuses a second question while the first waits', async () => {
    const f = await start();
    await join(f, en(310));
    await ask(f, en(310), 'First question');
    f.text(en(310), 'Second question');
    await until(async () => (await testDb.db.select().from(outbox)).length === 2, 'rejection');
    await deliver();
    expect(sentTo(f, 310).at(-1)!.params.text).toBe(getTexts('en').rejections.awaitingAnswer);
  });

  it('does not take an unknown command for a question', async () => {
    const f = await start();
    f.text(ru(320), '/frobnicate');
    await until(() => sentTo(f, 320).length === 1, 'help');
    expect(sentTo(f, 320)[0]!.params.text).toBe(getTexts('ru').bot.help);
    expect(await testDb.db.select().from(questions)).toHaveLength(0);
  });

  it('makes a person who blocked the bot reachable when they write again', async () => {
    const f = await start();
    await join(f, ru(330));
    await testDb.db.update(users).set({ botBlockedAt: new Date() });

    f.text(ru(330), '/help');
    f.text(ru(330), 'Вопрос после возвращения');
    await until(async () => (await userOf(330)).botBlockedAt === null, 'reachable again');
  });
});

describe('delivery', () => {
  it('sends without a sound in quiet hours', async () => {
    const f = await start();
    await settings.set({ QUIET_HOURS: '00:00-23:59', QUIET_HOURS_TZ: 'UTC' });
    f.text(ru(400), 'Тихий вопрос');
    await until(async () => (await testDb.db.select().from(outbox)).length === 1, 'event');
    await deliver();
    expect(sentTo(f, 400)[0]!.params).toMatchObject({ disable_notification: true });
  });

  it('sends with a sound outside quiet hours', async () => {
    const f = await start();
    await settings.set({ QUIET_HOURS: '00:00-00:00' });
    f.text(ru(401), 'Громкий вопрос');
    await until(async () => (await testDb.db.select().from(outbox)).length === 1, 'event');
    await deliver();
    expect(sentTo(f, 401)[0]!.params).not.toHaveProperty('disable_notification');
  });

  it('on 403 marks the person unreachable and takes the question back', async () => {
    const f = await start();
    await join(f, ru(410));
    await join(f, ru(411));
    await ask(f, ru(410), 'Кто там?');
    expect(await testDb.db.select().from(assignments)).toHaveLength(1);

    f.failures.set('sendMessage', {
      status: 403,
      description: 'Forbidden: bot was blocked by the user',
    });
    const result = await deliver();
    f.failures.clear();

    // The event counts as delivered: retrying cannot help
    expect(result).toMatchObject({ delivered: 1, retried: 0 });
    expect((await userOf(411)).botBlockedAt).not.toBeNull();
    const [assignment] = await testDb.db.select().from(assignments);
    expect(assignment).toMatchObject({ outcome: 'undeliverable' });
    expect((await testDb.db.select().from(questions))[0]).toMatchObject({ status: 'queued' });
  });

  it('on 429 keeps the event for a retry', async () => {
    const f = await start();
    f.text(ru(420), 'Вопрос');
    await until(async () => (await testDb.db.select().from(outbox)).length === 1, 'event');
    f.failures.set('sendMessage', {
      status: 429,
      description: 'Too Many Requests: retry after 1',
      parameters: { retry_after: 1 },
    });
    expect(await deliver()).toMatchObject({ delivered: 0, retried: 1 });
    f.failures.clear();
  });

  it('splits a question and answer longer than Telegram allows into several messages', async () => {
    const f = await start();
    await settings.set({ MESSAGE_MAX_LENGTH: 4000 });
    await join(f, ru(430));
    await join(f, ru(431));
    await ask(f, ru(430), 'в'.repeat(2500));
    await deliver();
    f.text(ru(431), 'о'.repeat(2500));
    await until(async () => (await testDb.db.select().from(answers)).length === 1, 'answer');
    const before = sentTo(f, 430).length;
    await deliver();

    const parts = sentTo(f, 430).slice(before);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(String(part.params.text).length).toBeLessThanOrEqual(4096);
    // Buttons only under the last part
    expect(parts.slice(0, -1).every((part) => !part.params.reply_markup)).toBe(true);
    expect(parts.at(-1)!.params.reply_markup).toBeDefined();
  });

  it('tells a person that "do not disturb" switched on by itself', async () => {
    const f = await start();
    await join(f, ru(440));
    const user = await userOf(440);
    await testDb.db.transaction(async (tx) => {
      const { emit } = await import('@human-msg/core');
      await emit(tx, user.id, { type: 'receiving.auto_disabled', missedDeadlines: 3 });
    });
    await deliver();
    expect(sentTo(f, 440).at(-1)!.params.text).toBe(
      getTexts('ru').notifications.autoDoNotDisturb(3),
    );
  });
});

describe('buttons', () => {
  async function assigned(f: FakeTelegram) {
    await join(f, en(500));
    await join(f, en(501));
    await ask(f, en(500), 'Question for a button');
    await deliver();
    const markup = sentTo(f, 501).at(-1)!.params.reply_markup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>;
    };
    const [skip, report] = markup.inline_keyboard[0]!;
    return { skip: skip!.callback_data, report: report!.callback_data };
  }

  it('skip hands the question on and rests the person', async () => {
    const f = await start();
    const buttons = await assigned(f);
    f.callback({ id: 501 }, buttons.skip);
    await until(
      async () => (await testDb.db.select().from(assignments))[0]?.outcome === 'skipped',
      'skip',
    );

    expect((await testDb.db.select().from(questions))[0]).toMatchObject({ status: 'queued' });
    expect((await userOf(501)).cooldownUntil).not.toBeNull();
    await until(() => f.called('answerCallbackQuery').length === 1, 'toast');
    expect(f.called('answerCallbackQuery')[0]!.params.text).toBe(
      getTexts('en').notifications.skipped,
    );
    expect(f.called('editMessageReplyMarkup')).toHaveLength(1);
  });

  it('report on a question blocks its author for the receiver', async () => {
    const f = await start();
    const buttons = await assigned(f);
    f.callback({ id: 501 }, buttons.report);
    await until(async () => (await testDb.db.select().from(blocks)).length === 1, 'block');

    const [block] = await testDb.db.select().from(blocks);
    expect(block).toMatchObject({
      authorId: (await userOf(500)).id,
      receiverId: (await userOf(501)).id,
    });
    expect((await testDb.db.select().from(assignments))[0]).toMatchObject({ outcome: 'reported' });
  });

  it('report under an answer blocks the responder for the author', async () => {
    const f = await start();
    const buttons = await assigned(f);
    void buttons;
    f.text(en(501), 'The answer');
    await until(async () => (await testDb.db.select().from(answers)).length === 1, 'answer');
    await deliver();
    const markup = sentTo(f, 500).at(-1)!.params.reply_markup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>;
    };
    f.callback({ id: 500 }, markup.inline_keyboard[0]![0]!.callback_data);
    await until(async () => (await testDb.db.select().from(blocks)).length === 1, 'block');

    const [block] = await testDb.db.select().from(blocks);
    expect(block).toMatchObject({
      authorId: (await userOf(500)).id,
      receiverId: (await userOf(501)).id,
    });
    await until(() => f.called('answerCallbackQuery').length === 1, 'toast');
    expect(f.called('answerCallbackQuery')[0]!.params.text).toBe(
      getTexts('en').notifications.answerReported,
    );
  });

  it('a button of an old question does not touch the current one', async () => {
    const f = await start();
    const buttons = await assigned(f);
    f.callback({ id: 501 }, `skip:${crypto.randomUUID()}`);
    await until(() => f.called('answerCallbackQuery').length === 1, 'toast');

    expect(f.called('answerCallbackQuery')[0]!.params.text).toBe(
      getTexts('en').rejections.answerTimeExpired,
    );
    expect((await testDb.db.select().from(assignments))[0]!.outcome).toBeNull();
    void buttons;
  });
});

describe('/stop and /resume', () => {
  it('no questions arrive after /stop, and they do after /resume', async () => {
    const f = await start();
    await join(f, ru(600));
    await join(f, ru(601));

    f.text(ru(601), '/stop');
    await until(() => sentTo(f, 601).length === 2, 'the reply to /stop');
    expect((await userOf(601)).receivingEnabled).toBe(false);
    expect(sentTo(f, 601).at(-1)!.params.text).toBe(getTexts('ru').bot.stopped);

    await ask(f, ru(600), 'Кто-нибудь?');
    expect((await testDb.db.select().from(questions))[0]).toMatchObject({ status: 'queued' });
    expect(await testDb.db.select().from(assignments)).toHaveLength(0);

    f.text(ru(601), '/resume');
    await until(() => sentTo(f, 601).length === 3, 'the reply to /resume');
    expect(await testDb.db.select().from(assignments)).toHaveLength(1);
    expect(sentTo(f, 601).at(-1)!.params.text).toBe(getTexts('ru').bot.resumed);
    expect((await userOf(601)).receivingEnabled).toBe(true);
  });

  it('/resume brings back a person switched off automatically', async () => {
    const f = await start();
    await join(f, en(610));
    await testDb.db.update(users).set({ receivingEnabled: false, missedDeadlines: 0 });

    f.text(en(610), '/resume');
    await until(async () => (await userOf(610)).receivingEnabled, 'resumed');
  });
});

describe('webhook', () => {
  const SECRET = 'webhook-secret';

  async function startWebhook() {
    fake = new FakeTelegram();
    const apiRoot = await fake.start();
    settings = createSettingsStore({ db: testDb.db, cacheMs: 0 });
    core = createCore({ db: testDb.db, settings });
    const app = Fastify();
    bot = await startTelegram({
      token: fake.token,
      apiRoot,
      core,
      log,
      mode: 'webhook',
      webhook: { url: 'https://example.com', secret: SECRET },
      app,
    });
    return app;
  }

  const update = (id: number, text: string) => ({
    update_id: 1,
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id, type: 'private' },
      from: { id, is_bot: false, first_name: 'Test', language_code: 'en' },
      text,
      entities: [{ type: 'bot_command', offset: 0, length: text.length }],
    },
  });

  it('registers the webhook with the secret', async () => {
    await startWebhook();
    expect(fake!.called('setWebhook')[0]!.params).toMatchObject({
      url: `https://example.com${WEBHOOK_PATH}`,
      secret_token: SECRET,
    });
    expect(fake!.called('getUpdates')).toHaveLength(0);
  });

  it('refuses a request without the secret', async () => {
    const app = await startWebhook();
    const response = await app.inject({
      method: 'POST',
      url: WEBHOOK_PATH,
      payload: update(700, '/start'),
    });
    expect(response.statusCode).toBe(401);
    expect(await testDb.db.select().from(users)).toHaveLength(0);
  });

  it('refuses a request with a wrong secret', async () => {
    const app = await startWebhook();
    const response = await app.inject({
      method: 'POST',
      url: WEBHOOK_PATH,
      headers: { 'x-telegram-bot-api-secret-token': 'nope' },
      payload: update(701, '/start'),
    });
    expect(response.statusCode).toBe(401);
  });

  it('handles an update that carries the secret', async () => {
    const app = await startWebhook();
    const response = await app.inject({
      method: 'POST',
      url: WEBHOOK_PATH,
      headers: { 'x-telegram-bot-api-secret-token': SECRET },
      payload: update(702, '/start'),
    });
    expect(response.statusCode).toBe(200);
    expect(sentTo(fake!, 702)).toHaveLength(1);
    expect(await testDb.db.select().from(users)).toHaveLength(1);
  });
});
