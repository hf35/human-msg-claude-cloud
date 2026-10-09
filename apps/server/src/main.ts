import { loadConfig, type Config } from './config';
import { startServer, type RunningServer } from './server';

/** If a graceful shutdown hangs (a stuck connection), the process exits anyway after this. */
const FORCE_EXIT_AFTER_MS = 10_000;

let config: Config;
try {
  config = loadConfig();
} catch (error) {
  // No logger yet; a bad configuration is a message for the operator, not a stack trace
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

let server: RunningServer;
try {
  server = await startServer(config);
} catch (error) {
  console.error('failed to start:', error);
  process.exit(1);
}
const { app } = server;

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  setTimeout(() => process.exit(1), FORCE_EXIT_AFTER_MS).unref();
  try {
    await server.stop();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, 'shutdown failed');
    process.exit(1);
  }
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
