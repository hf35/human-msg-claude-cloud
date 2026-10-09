import { z } from 'zod';

/**
 * Infrastructure settings and secrets, read from environment variables. Product settings
 * (deadlines, cooldowns, limits) are not here: they live in the database and change at runtime.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  // Loopback by default so a dev server is not exposed to the network by accident;
  // containers set HOST=0.0.0.0
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Names this server's rows in `web_connections`; on start it removes the ones it left behind.
  // Keep it stable across restarts and distinct between simultaneously running servers.
  SERVER_ID: z.string().trim().min(1).default('server-1'),
  // Seconds between passes of the worker (deadlines, reminders, queue) ...
  WORKER_INTERVAL: z.coerce.number().positive().default(5),
  // ... and of the outbox dispatcher; NOTIFY wakes it earlier, the timer is the safety net
  DISPATCH_INTERVAL: z.coerce.number().positive().default(5),
  // OAuth client id of the web app; ID tokens issued for any other client are refused.
  // Without it Google sign-in is off (local development can use DEV_LOGIN instead).
  GOOGLE_CLIENT_ID: z.string().trim().min(1).optional(),
  // Sign-in without Google for local development; refused outside NODE_ENV=development
  DEV_LOGIN: z
    .enum(['true', 'false', '1', '0'])
    .default('false')
    .transform((value) => value === 'true' || value === '1'),
  // Seconds between WebSocket pings; a connection that misses one pong is closed
  WS_PING_INTERVAL: z.coerce.number().positive().default(30),
  DATABASE_URL: z
    .string({ error: 'is not set (see .env.example)' })
    .trim()
    .min(1, 'is not set (see .env.example)'),
});

export interface Config {
  nodeEnv: 'development' | 'production' | 'test';
  host: string;
  port: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  databaseUrl: string;
  googleClientId?: string;
  /** Sign-in without Google; only ever true when `nodeEnv` is `development`. */
  devLogin: boolean;
  serverId: string;
  wsPingIntervalMs: number;
  workerIntervalMs: number;
  dispatchIntervalMs: number;
}

/** Validates the environment once at startup. Throws one error naming every bad variable. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${problems}`);
  }
  const values = parsed.data;
  if (values.DEV_LOGIN && values.NODE_ENV !== 'development') {
    // A forgotten flag must not open a passwordless door; failing loudly beats ignoring it
    throw new Error('Invalid configuration: DEV_LOGIN: allowed only when NODE_ENV=development');
  }
  return {
    nodeEnv: values.NODE_ENV,
    host: values.HOST,
    port: values.PORT,
    logLevel: values.LOG_LEVEL,
    databaseUrl: values.DATABASE_URL,
    ...(values.GOOGLE_CLIENT_ID && { googleClientId: values.GOOGLE_CLIENT_ID }),
    devLogin: values.DEV_LOGIN,
    serverId: values.SERVER_ID,
    workerIntervalMs: Math.round(values.WORKER_INTERVAL * 1000),
    dispatchIntervalMs: Math.round(values.DISPATCH_INTERVAL * 1000),
    wsPingIntervalMs: Math.round(values.WS_PING_INTERVAL * 1000),
  };
}
