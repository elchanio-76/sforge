import type { Writable } from 'node:stream';

/** Process boundary, injectable so commands can be tested without spawning. */
export interface Io {
  stdout: Writable & { isTTY?: boolean };
  stderr: Writable & { isTTY?: boolean };
  stdinIsTTY: boolean;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export function processIo(): Io {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    stdinIsTTY: process.stdin.isTTY === true,
    env: process.env,
    cwd: process.cwd(),
  };
}
