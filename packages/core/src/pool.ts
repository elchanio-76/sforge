import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';

/** A function a worker can run: the URL of its module and the name of the export. */
export interface Task {
  module: string;
  fn: string;
}

/**
 * Worker threads that run exported functions of other modules. Inputs and
 * results are structured-cloned, so they must be plain data.
 */
export interface WorkerPool {
  readonly size: number;
  run<T>(task: Task, input: unknown): Promise<T>;
  /** Terminate the workers; tasks still queued are rejected. */
  close(): Promise<void>;
}

/** Workers used when `build.workers` is "auto": all but one core, at most 8. */
export function defaultPoolSize(): number {
  return Math.max(1, Math.min(availableParallelism() - 1, 8));
}

/**
 * The pool size for a `build.workers` setting; the SFORGE_WORKERS environment
 * variable overrides it (0 runs everything in the main thread).
 */
export function poolSize(setting: number | 'auto', env: NodeJS.ProcessEnv = process.env): number {
  const fromEnv = env.SFORGE_WORKERS;
  if (fromEnv !== undefined && fromEnv !== '') {
    const n = Number(fromEnv);
    if (Number.isInteger(n) && n >= 0) return n;
  }
  return setting === 'auto' ? defaultPoolSize() : setting;
}

interface Pending {
  task: Task;
  input: unknown;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

type Reply =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: { message: string; stack?: string } };

// From TypeScript sources (tests), workers strip types themselves and resolve
// `.js` imports to `.ts` files and workspace packages to their sources.
const fromSource = import.meta.url.endsWith('.ts');
const workerUrl = new URL(fromSource ? './pool-worker.ts' : './pool-worker.js', import.meta.url);
const execArgv = fromSource
  ? [
      '--conditions=@staticforge/source',
      '--import',
      new URL('./source-hooks.mjs', import.meta.url).href,
    ]
  : [];

export function createWorkerPool(size: number): WorkerPool {
  const idle: Worker[] = [];
  const busy = new Map<Worker, Pending>();
  const queue: Pending[] = [];
  let spawned = 0;
  let nextId = 0;
  let closed = false;

  const spawn = (): Worker => {
    const worker = new Worker(workerUrl, { execArgv });
    spawned++;
    worker.on('message', (reply: Reply) => {
      const pending = busy.get(worker);
      busy.delete(worker);
      if (pending !== undefined) {
        if (reply.ok) pending.resolve(reply.value);
        else
          pending.reject(
            Object.assign(new Error(reply.error.message), { stack: reply.error.stack }),
          );
      }
      idle.push(worker);
      dispatch();
    });
    const lost = (error: Error) => {
      const pending = busy.get(worker);
      busy.delete(worker);
      const i = idle.indexOf(worker);
      if (i !== -1) idle.splice(i, 1);
      spawned--;
      pending?.reject(error);
      dispatch();
    };
    worker.on('error', lost);
    worker.on('exit', (code) => {
      if (!closed) lost(new Error(`A build worker exited with code ${code}`));
    });
    return worker;
  };

  const dispatch = () => {
    while (queue.length > 0 && !closed) {
      const worker = idle.pop() ?? (spawned < size ? spawn() : undefined);
      if (worker === undefined) return;
      const pending = queue.shift() as Pending;
      busy.set(worker, pending);
      worker.postMessage({ id: nextId++, ...pending.task, input: pending.input });
    }
  };

  return {
    size,
    run<T>(task: Task, input: unknown): Promise<T> {
      if (closed) return Promise.reject(new Error('The worker pool is closed'));
      return new Promise<T>((resolve, reject) => {
        queue.push({ task, input, resolve: resolve as (value: unknown) => void, reject });
        dispatch();
      });
    },
    async close() {
      closed = true;
      for (const pending of queue.splice(0))
        pending.reject(new Error('The worker pool was closed'));
      const workers = [...idle, ...busy.keys()];
      for (const pending of busy.values()) pending.reject(new Error('The worker pool was closed'));
      busy.clear();
      idle.length = 0;
      await Promise.all(workers.map((worker) => worker.terminate()));
    },
  };
}

/**
 * Run `task` over `items` in chunks, in the pool when there is one, otherwise
 * (or for few items) by calling `local` in this thread. Results keep the order
 * of `items`.
 */
export async function mapInPool<I, R, C>(
  pool: WorkerPool | undefined,
  task: Task,
  items: I[],
  context: C,
  local: (input: { items: I[]; context: C }) => Promise<R[]> | R[],
  options: { minItems?: number } = {},
): Promise<R[]> {
  if (pool === undefined || pool.size === 0 || items.length < (options.minItems ?? 1)) {
    return local({ items, context });
  }
  // A few chunks per worker balance uneven pages without cloning the context too often.
  const chunkSize = Math.max(1, Math.ceil(items.length / (pool.size * 4)));
  const chunks: I[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) chunks.push(items.slice(i, i + chunkSize));
  const results = await Promise.all(
    chunks.map((chunk) => pool.run<R[]>(task, { items: chunk, context })),
  );
  return results.flat();
}
