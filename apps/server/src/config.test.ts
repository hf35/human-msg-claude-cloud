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

  it('enables the dev login only in development', () => {
    expect(loadConfig({ DATABASE_URL, NODE_ENV: 'development', DEV_LOGIN: 'true' }).devLogin).toBe(
      true,
    );
    expect(loadConfig({ DATABASE_URL, NODE_ENV: 'production' }).devLogin).toBe(false);
    for (const NODE_ENV of ['production', 'test']) {
      expect(() => loadConfig({ DATABASE_URL, NODE_ENV, DEV_LOGIN: 'true' })).toThrow(/DEV_LOGIN/);
    }
  });
});
