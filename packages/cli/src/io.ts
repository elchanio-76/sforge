import type { Writable } from 'node:stream';

/** Process boundary, injectable so commands can be tested without spawning. */
export interface Io {
  stdout: Writable & { isTTY?: boolean };
  stderr: Writable & { isTTY?: boolean };
  stdinIsTTY: boolean;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Run `handler` once on SIGINT/SIGTERM; returns an unsubscribe function. */
  onShutdown(handler: () => void): () => void;
}

export function processIo(): Io {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    stdinIsTTY: process.stdin.isTTY === true,
    env: process.env,
    cwd: process.cwd(),
    onShutdown(handler) {
      const signals = ['SIGINT', 'SIGTERM'] as const;
      const once = () => {
        for (const signal of signals) process.off(signal, once);
        handler();
      };
      for (const signal of signals) process.on(signal, once);
      return () => {
        for (const signal of signals) process.off(signal, once);
      };
    },
  };
}
