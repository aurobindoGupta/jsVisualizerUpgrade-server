import path from 'path';
import { Worker } from 'worker_threads';
import type { ExecutionEvent } from '../types/events';

const HARD_TIMEOUT_MS = 8000;

// In development (ts-node), __filename ends with .ts; in production it ends with .js.
// We pass execArgv to the Worker so it can also load TypeScript when running in dev mode.
const isDev = !__filename.endsWith('.js');
const WORKER_FILE = isDev
  ? path.resolve(__dirname, '../worker/worker.ts')
  : path.resolve(__dirname, '../worker/worker.js');
const WORKER_EXEC_ARGV = isDev ? ['--require', 'ts-node/register'] : [];

export interface WorkerHandle {
  promise: Promise<ExecutionEvent[]>;
  worker: Worker;
}

export const launchWorker = (jsSourceCode: string): WorkerHandle => {
  const worker = new Worker(WORKER_FILE, {
    workerData: jsSourceCode,
    execArgv: WORKER_EXEC_ARGV,
  });

  const promise = new Promise<ExecutionEvent[]>((resolve) => {
    const events: ExecutionEvent[] = [];
    let settled = false;

    // Hard timeout: kill the worker from the outside if it somehow outlives its
    // internal 5 s deadline (e.g. promise hell that never resolves).
    const hardTimeoutId = setTimeout(() => {
      if (!settled) {
        worker.terminate();
      }
    }, HARD_TIMEOUT_MS);

    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimeoutId);
      resolve(events);
    };

    worker.on('message', (msg: string) => {
      try {
        const evt = JSON.parse(msg) as ExecutionEvent;
        events.push(evt);
        // Resolve as soon as a terminal event arrives; the worker will exit shortly after.
        if (
          evt.type === 'Done' ||
          evt.type === 'EarlyTermination' ||
          evt.type === 'UncaughtError'
        ) {
          settle();
        }
      } catch {
        // Ignore malformed worker messages
      }
    });

    worker.on('error', (err: Error) => {
      events.push({
        type: 'UncaughtError',
        payload: { name: err.name, message: err.message, stack: err.stack },
      });
      settle();
    });

    // Always resolve on exit so callers never hang
    worker.on('exit', () => settle());
  });

  return { promise, worker };
};
