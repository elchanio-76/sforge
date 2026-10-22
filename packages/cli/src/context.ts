import { resolve } from 'node:path';
import type { Command } from 'commander';
import { type Logger, createLogger, shouldUseColor } from '@staticforge/core';
import type { Io } from './io.js';

/** Options accepted by every command. */
export interface GlobalOptions {
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  cwd?: string;
  config?: string;
  color?: boolean;
  nonInteractive?: boolean;
}

export interface CommandContext {
  io: Io;
  logger: Logger;
  /** Absolute working directory (from --cwd or the process). */
  cwd: string;
  /** Explicit config path from --config. */
  configPath: string | undefined;
  json: boolean;
  /** False under CI, without a TTY, or with --non-interactive: never prompt. */
  interactive: boolean;
  color: boolean;
}

export function createContext(command: Command, io: Io): CommandContext {
  const opts = command.optsWithGlobals<GlobalOptions>();
  const json = opts.json === true;
  const color = opts.color !== false && shouldUseColor(io.stderr, io.env);
  const level = opts.quiet ? 'error' : opts.verbose ? 'debug' : 'info';
  const ci = io.env.CI !== undefined && io.env.CI !== '' && io.env.CI !== 'false';

  return {
    io,
    logger: createLogger({ level, color, stream: io.stderr }),
    cwd: opts.cwd !== undefined ? resolve(io.cwd, opts.cwd) : io.cwd,
    configPath: opts.config,
    json,
    interactive: opts.nonInteractive !== true && !ci && io.stdinIsTTY,
    color,
  };
}
