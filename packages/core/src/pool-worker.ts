import { parentPort } from 'node:worker_threads';

/** Entry point of a pool worker: runs `fn` of `module` for each message. */
interface Message {
  id: number;
  module: string;
  fn: string;
  input: unknown;
}

const port = parentPort;
if (port === null) throw new Error('pool-worker must run in a worker thread');

const modules = new Map<string, Promise<Record<string, unknown>>>();

port.on('message', async ({ id, module, fn, input }: Message) => {
  try {
    let loaded = modules.get(module);
    if (loaded === undefined) {
      loaded = import(module) as Promise<Record<string, unknown>>;
      modules.set(module, loaded);
    }
    const run = (await loaded)[fn];
    if (typeof run !== 'function') throw new Error(`${module} has no function "${fn}"`);
    port.postMessage({ id, ok: true, value: await (run as (input: unknown) => unknown)(input) });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    port.postMessage({ id, ok: false, error: { message: err.message, stack: err.stack } });
  }
});
