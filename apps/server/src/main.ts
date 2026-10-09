import { buildApp } from './app';
import { loadConfig } from './config';

/** If a graceful shutdown hangs (a stuck connection), the process exits anyway after this. */
const FORCE_EXIT_AFTER_MS = 10_000;

let config;
try {
  config = loadConfig();
} catch (error) {
  // No logger yet; a bad configuration is a message for the operator, not a stack trace
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
const app = buildApp({ config });

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  setTimeout(() => process.exit(1), FORCE_EXIT_AFTER_MS).unref();
  try {
    // Stops accepting connections and waits for requests in flight
    await app.close();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, 'shutdown failed');
    process.exit(1);
  }
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error({ err: error }, 'failed to start');
  process.exit(1);
}
