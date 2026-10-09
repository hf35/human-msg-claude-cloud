import { createCore, createSettingsStore } from '@human-msg/core';
import { users } from '@human-msg/db';
import { createTestDatabase, type TestDatabase } from '@human-msg/db/testing';
import { getTexts } from '@human-msg/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeTelegram } from './fake-telegram';
import { startTelegram, type RunningTelegram } from './index';

let testDb: TestDatabase;
let fake: FakeTelegram | undefined;
let bot: RunningTelegram | undefined;

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

async function start() {
  fake = new FakeTelegram();
  const apiRoot = await fake.start();
  bot = await startTelegram({
    token: fake.token,
    apiRoot,
    core: createCore({ db: testDb.db, settings: createSettingsStore({ db: testDb.db }) }),
    log: { info: () => {}, error: () => {} },
  });
  return fake;
}

const eventually = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for: ${what}`);
};

const sent = (f: FakeTelegram) => f.called('sendMessage').map((c) => c.params);
const rows = () => testDb.db.select().from(users);

describe('/start', () => {
  it('registers a Russian-speaking person: alias and rules in Russian', async () => {
    const f = await start();
    f.text({ id: 4242, language_code: 'ru' }, '/start');
    await eventually(() => sent(f).length === 1, 'the greeting');

    const [user] = await rows();
    expect(user).toMatchObject({ channel: 'telegram', telegramId: 4242, locale: 'ru' });
    expect(user!.alias).toMatch(/[А-Яа-яЁё]/);
    const text = String(sent(f)[0]!.text);
    expect(text).toContain(`«${user!.alias}»`);
    expect(text).toContain('Как это работает');
    expect(text).toContain('2000');
    expect(text).toContain('10');
  });

  it('registers an English-speaking person: alias and rules in English', async () => {
    const f = await start();
    f.text({ id: 4243, language_code: 'en-US' }, '/start');
    await eventually(() => sent(f).length === 1, 'the greeting');

    const [user] = await rows();
    expect(user).toMatchObject({ telegramId: 4243, locale: 'en' });
    expect(user!.alias).not.toMatch(/[А-Яа-яЁё]/);
    const text = String(sent(f)[0]!.text);
    expect(text).toContain(`"${user!.alias}"`);
    expect(text).toContain('How it works');
    expect(text).not.toMatch(/[А-Яа-яЁё]/);
  });

  it.each([['de'], ['uk'], [undefined]])(
    'uses the default language for the Telegram language %s',
    async (languageCode) => {
      const f = await start();
      f.text({ id: 4244, ...(languageCode && { language_code: languageCode }) }, '/start');
      await eventually(() => sent(f).length === 1, 'the greeting');
      expect((await rows())[0]!.locale).toBe('ru');
    },
  );

  it('is harmless to repeat: one account, the same alias', async () => {
    const f = await start();
    f.text({ id: 4245, language_code: 'en' }, '/start');
    await eventually(() => sent(f).length === 1, 'the first greeting');
    f.text({ id: 4245, language_code: 'en' }, '/start');
    await eventually(() => sent(f).length === 2, 'the second greeting');

    const all = await rows();
    expect(all).toHaveLength(1);
    expect(String(sent(f)[1]!.text)).toContain(all[0]!.alias);
  });

  it('keeps the language chosen at registration even if Telegram switches', async () => {
    const f = await start();
    f.text({ id: 4246, language_code: 'en' }, '/start');
    await eventually(() => sent(f).length === 1, 'the first greeting');
    f.text({ id: 4246, language_code: 'ru' }, '/start');
    await eventually(() => sent(f).length === 2, 'the second greeting');
    expect(String(sent(f)[1]!.text)).toContain('How it works');
  });

  it('gives different people different aliases', async () => {
    const f = await start();
    for (let id = 1; id <= 5; id++) f.text({ id: 5000 + id, language_code: 'en' }, '/start');
    await eventually(() => sent(f).length === 5, 'five greetings');
    expect(new Set((await rows()).map((u) => u.alias)).size).toBe(5);
  });
});

describe('/help', () => {
  it('answers in the language of a registered person', async () => {
    const f = await start();
    f.text({ id: 6001, language_code: 'en' }, '/start');
    await eventually(() => sent(f).length === 1, 'the greeting');
    // Telegram now reports Russian, but the account speaks English
    f.text({ id: 6001, language_code: 'ru' }, '/help');
    await eventually(() => sent(f).length === 2, 'the help');
    expect(sent(f)[1]!.text).toBe(getTexts('en').bot.help);
  });

  it('answers a stranger in their Telegram language without registering them', async () => {
    const f = await start();
    f.text({ id: 6002, language_code: 'en-GB' }, '/help');
    await eventually(() => sent(f).length === 1, 'the help');
    expect(sent(f)[0]!.text).toBe(getTexts('en').bot.help);
    expect(await rows()).toHaveLength(0);
  });
});

describe('/language', () => {
  it('offers both languages as buttons', async () => {
    const f = await start();
    f.text({ id: 7001, language_code: 'ru' }, '/language');
    await eventually(() => sent(f).length === 1, 'the prompt');
    expect(sent(f)[0]).toMatchObject({
      text: 'Выберите язык:',
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Русский', callback_data: 'lang:ru' },
            { text: 'English', callback_data: 'lang:en' },
          ],
        ],
      },
    });
  });

  it('switches the language with a button; the alias stays', async () => {
    const f = await start();
    f.text({ id: 7002, language_code: 'ru' }, '/start');
    await eventually(() => sent(f).length === 1, 'the greeting');
    const alias = (await rows())[0]!.alias;

    f.callback({ id: 7002 }, 'lang:en');
    await eventually(() => f.called('editMessageText').length === 1, 'the confirmation');
    expect(f.called('editMessageText')[0]!.params.text).toBe('Language switched: English.');
    expect(f.called('answerCallbackQuery')).toHaveLength(1);

    const [user] = await rows();
    expect(user).toMatchObject({ locale: 'en', alias });

    // From now on the bot speaks English to this person
    f.text({ id: 7002, language_code: 'ru' }, '/help');
    await eventually(() => sent(f).length === 2, 'the help');
    expect(sent(f)[1]!.text).toBe(getTexts('en').bot.help);
  });

  it('switches the language with an argument', async () => {
    const f = await start();
    f.text({ id: 7003, language_code: 'en' }, '/language ru');
    await eventually(() => sent(f).length === 1, 'the confirmation');
    expect(sent(f)[0]!.text).toBe('Язык переключён: русский.');
    expect((await rows())[0]!.locale).toBe('ru');
  });

  it('ignores a made-up language and shows the buttons instead', async () => {
    const f = await start();
    f.text({ id: 7004, language_code: 'en' }, '/language klingon');
    await eventually(() => sent(f).length === 1, 'the prompt');
    expect(sent(f)[0]!.text).toBe('Choose a language:');
    expect((await rows())[0]!.locale).toBe('en');
  });

  it('ignores a made-up button', async () => {
    const f = await start();
    f.text({ id: 7005, language_code: 'en' }, '/start');
    await eventually(() => sent(f).length === 1, 'the greeting');
    f.callback({ id: 7005 }, 'lang:tlh');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(f.called('editMessageText')).toHaveLength(0);
    expect((await rows())[0]!.locale).toBe('en');
  });
});
