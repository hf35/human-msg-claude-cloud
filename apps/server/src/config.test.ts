import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

const DATABASE_URL = 'postgres://u:p@localhost:5432/db';

describe('loadConfig', () => {
  it('uses defaults for everything except the database', () => {
    expect(loadConfig({ DATABASE_URL })).toEqual({
      nodeEnv: 'development',
      host: '127.0.0.1',
      port: 3000,
      logLevel: 'info',
      databaseUrl: DATABASE_URL,
      devLogin: false,
      trustProxy: false,
      serverId: 'server-1',
      workerIntervalMs: 5000,
      dispatchIntervalMs: 5000,
      wsPingIntervalMs: 30000,
    });
  });

  it('reads values from the environment and converts the port to a number', () => {
    const config = loadConfig({
      DATABASE_URL,
      NODE_ENV: 'production',
      HOST: '0.0.0.0',
      PORT: '8080',
      LOG_LEVEL: 'warn',
    });
    expect(config).toMatchObject({
      nodeEnv: 'production',
      host: '0.0.0.0',
      port: 8080,
      logLevel: 'warn',
    });
  });

  it('reads the server id and the intervals in seconds', () => {
    const config = loadConfig({
      DATABASE_URL,
      SERVER_ID: 'eu-1',
      WORKER_INTERVAL: '2.5',
      DISPATCH_INTERVAL: '10',
    });
    expect(config).toMatchObject({
      serverId: 'eu-1',
      workerIntervalMs: 2500,
      dispatchIntervalMs: 10_000,
    });
  });

  it('rejects an empty server id and non-positive intervals', () => {
    expect(() => loadConfig({ DATABASE_URL, SERVER_ID: ' ' })).toThrow(/SERVER_ID/);
    expect(() => loadConfig({ DATABASE_URL, WORKER_INTERVAL: '0' })).toThrow(/WORKER_INTERVAL/);
    expect(() => loadConfig({ DATABASE_URL, DISPATCH_INTERVAL: '-1' })).toThrow(
      /DISPATCH_INTERVAL/,
    );
  });

  it('fails when the database url is missing or blank', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ DATABASE_URL: '   ' })).toThrow(/DATABASE_URL/);
  });

  it('rejects invalid values and names every bad variable at once', () => {
    expect(() => loadConfig({ DATABASE_URL, PORT: 'abc', LOG_LEVEL: 'loud' })).toThrow(
      /PORT.*LOG_LEVEL/,
    );
    expect(() => loadConfig({ DATABASE_URL, PORT: '70000' })).toThrow(/PORT/);
  });

  it('reads the Google client id', () => {
    expect(
      loadConfig({ DATABASE_URL, GOOGLE_CLIENT_ID: ' abc.apps.googleusercontent.com ' }),
    ).toMatchObject({
      googleClientId: 'abc.apps.googleusercontent.com',
    });
  });

  it('trusts the reverse proxy only when told to', () => {
    expect(loadConfig({ DATABASE_URL }).trustProxy).toBe(false);
    expect(loadConfig({ DATABASE_URL, TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(() => loadConfig({ DATABASE_URL, TRUST_PROXY: 'yes' })).toThrow(/TRUST_PROXY/);
  });

  it('enables the dev login only in development', () => {
    expect(loadConfig({ DATABASE_URL, NODE_ENV: 'development', DEV_LOGIN: 'true' }).devLogin).toBe(
      true,
    );
    expect(loadConfig({ DATABASE_URL, NODE_ENV: 'production' }).devLogin).toBe(false);
    for (const NODE_ENV of ['production', 'test']) {
      expect(() => loadConfig({ DATABASE_URL, NODE_ENV, DEV_LOGIN: 'true' })).toThrow(/DEV_LOGIN/);
    }
  });

  it('reads the back office credentials, both or neither', async () => {
    const { hashPassword } = await import('./admin/password');
    const passwordHash = await hashPassword('secret123');
    expect(loadConfig({ DATABASE_URL }).backoffice).toBeUndefined();
    expect(
      loadConfig({
        DATABASE_URL,
        BACKOFFICE_LOGIN: 'admin',
        BACKOFFICE_PASSWORD_HASH: passwordHash,
      }).backoffice,
    ).toEqual({ login: 'admin', passwordHash });
    expect(() => loadConfig({ DATABASE_URL, BACKOFFICE_LOGIN: 'admin' })).toThrow(/together/);
    expect(() =>
      loadConfig({ DATABASE_URL, BACKOFFICE_LOGIN: 'a', BACKOFFICE_PASSWORD_HASH: 'plain' }),
    ).toThrow(/BACKOFFICE_PASSWORD_HASH/);
  });

  it('has no bot without a token', () => {
    expect(loadConfig({ DATABASE_URL }).telegram).toBeUndefined();
  });

  it('configures the bot', () => {
    expect(loadConfig({ DATABASE_URL, TELEGRAM_BOT_TOKEN: ' 1:abc ' }).telegram).toEqual({
      token: '1:abc',
      mode: 'polling',
    });
    expect(
      loadConfig({
        DATABASE_URL,
        TELEGRAM_BOT_TOKEN: '1:abc',
        TELEGRAM_MODE: 'webhook',
        TELEGRAM_WEBHOOK_SECRET: 'sec_ret-1',
        PUBLIC_URL: 'https://example.com/',
        TELEGRAM_API_ROOT: 'http://localhost:8081',
      }).telegram,
    ).toEqual({
      token: '1:abc',
      mode: 'webhook',
      apiRoot: 'http://localhost:8081',
      webhook: { url: 'https://example.com', secret: 'sec_ret-1' },
    });
  });

  it('refuses webhook mode without a secret or a public address', () => {
    const base = { DATABASE_URL, TELEGRAM_BOT_TOKEN: '1:abc', TELEGRAM_MODE: 'webhook' };
    expect(() => loadConfig(base)).toThrow(/TELEGRAM_WEBHOOK_SECRET/);
    expect(() => loadConfig({ ...base, TELEGRAM_WEBHOOK_SECRET: 'abc' })).toThrow(/PUBLIC_URL/);
    expect(() =>
      loadConfig({
        ...base,
        PUBLIC_URL: 'https://example.com',
        TELEGRAM_WEBHOOK_SECRET: 'bad secret!',
      }),
    ).toThrow(/TELEGRAM_WEBHOOK_SECRET/);
  });

  it('refuses an unknown Telegram mode', () => {
    expect(() => loadConfig({ DATABASE_URL, TELEGRAM_MODE: 'carrier-pigeon' })).toThrow(
      /TELEGRAM_MODE/,
    );
  });

  it('treats an empty value as not set', () => {
    const config = loadConfig({
      DATABASE_URL,
      GOOGLE_CLIENT_ID: '',
      TELEGRAM_BOT_TOKEN: '  ',
      TELEGRAM_API_ROOT: '',
    });
    expect(config.googleClientId).toBeUndefined();
    expect(config.telegram).toBeUndefined();
  });

  it('accepts .env.example as it is: the documented first run is `cp .env.example .env`', () => {
    const env = Object.fromEntries(
      readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8')
        .split('\n')
        .filter((line) => line.trim() && !line.trim().startsWith('#'))
        .map((line) => {
          const at = line.indexOf('=');
          return [line.slice(0, at), line.slice(at + 1)];
        }),
    );
    expect(() => loadConfig(env)).not.toThrow();
  });
});
