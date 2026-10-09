import { createDb, createPool, runMigrations } from '@human-msg/db';
import { loadConfig, startServer } from '@human-msg/server';
import pg from 'pg';
import { API_PORT } from './ports';

/**
 * The server of the end-to-end run: its own database, created empty on every start so runs
 * never see each other's data, with the development sign-in switched on.
 */
const BASE_URL = process.env.DATABASE_URL ?? 'postgres://humanmsg:humanmsg@localhost:5432/humanmsg';
const DATABASE = 'humanmsg_e2e';

const url = new URL(BASE_URL);
const admin = new pg.Client({ connectionString: BASE_URL });
await admin.connect();
try {
  await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DATABASE}`);
} finally {
  await admin.end();
}
url.pathname = `/${DATABASE}`;

const pool = createPool(url.toString());
await runMigrations(createDb(pool));
await pool.end();

const server = await startServer(
  loadConfig({
    DATABASE_URL: url.toString(),
    NODE_ENV: 'development',
    DEV_LOGIN: 'true',
    HOST: '127.0.0.1',
    PORT: String(API_PORT),
    LOG_LEVEL: 'warn',
    SERVER_ID: 'e2e',
  }),
);
console.log(`e2e server listening on ${server.address}`);

const stop = () => void server.stop().finally(() => process.exit(0));
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
