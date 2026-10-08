import type { Core } from './core';
import {
  processDeadlines,
  processExpiredQuestions,
  processQueue,
  processReminders,
} from './worker';

/** How many records each step handled in one pass. */
export interface TickResult {
  timedOut: number;
  reminded: number;
  expired: number;
  assigned: number;
}

/**
 * One pass of the worker. The order matters: overdue assignments go back to the queue first,
 * then reminders are sent, then queued questions out of time expire, and what is left in the
 * queue is handed to whoever can take it. Every step is idempotent, and several workers may run
 * at once: each record is taken under `SKIP LOCKED` and rechecked, so it is handled once.
 */
export async function tick(core: Core): Promise<TickResult> {
  const timedOut = await processDeadlines(core);
  const reminded = await processReminders(core);
  const expired = await processExpiredQuestions(core);
  const assigned = await processQueue(core);
  return { timedOut, reminded, expired, assigned };
}

export interface WorkerOptions {
  core: Core;
  /** Pause between the end of one pass and the start of the next. */
  intervalMs: number;
  /** Called when a pass fails; the worker keeps running. */
  onError?: (error: unknown) => void;
}

export interface Worker {
  /** Stops scheduling passes and waits for the current one to finish. */
  stop(): Promise<void>;
}

/**
 * Runs `tick` every `intervalMs`. The next pass is scheduled only after the previous one has
 * finished, so passes of one worker never overlap, however slow they are. A failed pass is
 * reported to `onError` and does not stop the worker.
 */
export function startWorker(options: WorkerOptions): Worker {
  const { core, intervalMs, onError } = options;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: Promise<void> = Promise.resolve();

  const pass = async () => {
    try {
      await tick(core);
    } catch (error) {
      onError?.(error);
    }
  };
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      current = pass().finally(schedule);
    }, intervalMs);
  };
  schedule();

  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await current;
    },
  };
}
