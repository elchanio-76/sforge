import { Writable } from 'node:stream';
import { ExitCode } from '@staticforge/core';
import type { Outcome, Runtime } from '../command.js';
import type { Io } from '../io.js';

/** The CLI entry point (`run` from main.ts), passed in to avoid an import cycle. */
export type RunCli = (
  argv: string[],
  io: Io,
  hooks: Pick<Runtime, 'providers' | 'onResult'>,
) => Promise<ExitCode>;

export interface InvokeOptions {
  run: RunCli;
  cwd: string;
  /** Global options for every command, e.g. ["--config", "site.yaml", "--quiet"]. */
  globalArgs?: string[];
  env: NodeJS.ProcessEnv;
  providers?: Runtime['providers'];
  /** Receives each line the command logs. */
  onLog?(line: string): void;
}

export interface Invocation {
  /** The command's result, as soon as it has one (servers: once they listen). */
  outcome: Promise<Outcome>;
  /** Settles when the command has finished; servers run until {@link stop}. */
  done: Promise<ExitCode>;
  /** Stop a long-running command, as Ctrl+C would. */
  stop(): void;
}

/** A stream that hands complete lines to `onLine`. */
function lineStream(onLine: (line: string) => void): Writable & { flush(): void } {
  let pending = '';
  const stream = new Writable({
    write(chunk, _encoding, done) {
      pending += String(chunk);
      for (let i = pending.indexOf('\n'); i !== -1; i = pending.indexOf('\n')) {
        onLine(pending.slice(0, i));
        pending = pending.slice(i + 1);
      }
      done();
    },
  });
  return Object.assign(stream, {
    flush() {
      if (pending !== '') onLine(pending);
      pending = '';
    },
  });
}

/**
 * Run a CLI command in this process, exactly as `sforge <args> --json` would,
 * without prompts. The envelope goes to `outcome`; stdout is discarded.
 */
export function invoke(args: string[], options: InvokeOptions): Invocation {
  const shutdown: (() => void)[] = [];
  const stderr = lineStream((line) => options.onLog?.(line));
  const io: Io = {
    stdout: new Writable({ write: (_chunk, _encoding, done) => done() }),
    stderr,
    stdinIsTTY: false,
    env: options.env,
    cwd: options.cwd,
    onShutdown(handler) {
      shutdown.push(handler);
      return () => {
        const i = shutdown.indexOf(handler);
        if (i !== -1) shutdown.splice(i, 1);
      };
    },
    prompt: () => Promise.reject(new Error('Commands run over MCP cannot prompt')),
  };

  let settle!: (outcome: Outcome) => void;
  let fail!: (error: unknown) => void;
  let settled = false;
  const outcome = new Promise<Outcome>((resolve, reject) => {
    settle = (value) => {
      settled = true;
      resolve(value);
    };
    fail = reject;
  });

  const argv = ['node', 'sforge', '--json', ...(options.globalArgs ?? []), ...args];
  const done = options
    .run(argv, io, {
      ...(options.providers && { providers: options.providers }),
      onResult: (result) => {
        if (!settled) settle(result);
      },
    })
    .then(
      (code) => {
        stderr.flush();
        if (!settled) fail(new Error(`sforge ${args[0] ?? ''} ended without a result`));
        return code;
      },
      (error: unknown) => {
        stderr.flush();
        fail(error);
        return ExitCode.Internal;
      },
    );

  return {
    outcome,
    done,
    stop: () => shutdown.splice(0).forEach((handler) => handler()),
  };
}
