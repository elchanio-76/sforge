import type { Writable } from 'node:stream';

export const LogLevels = ['silent', 'error', 'warn', 'info', 'debug'] as const;
export type LogLevel = (typeof LogLevels)[number];

type MessageLevel = Exclude<LogLevel, 'silent'>;

export interface Logger {
  readonly level: LogLevel;
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
  debug(message: string): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  color?: boolean;
  /** Defaults to stderr: stdout is reserved for command results. */
  stream?: Writable;
}

const rank: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

const style: Record<MessageLevel, { label: string; ansi: string }> = {
  error: { label: 'error', ansi: '\x1b[31m' },
  warn: { label: 'warn', ansi: '\x1b[33m' },
  info: { label: 'info', ansi: '\x1b[36m' },
  debug: { label: 'debug', ansi: '\x1b[90m' },
};

/**
 * Human-oriented logger. All output goes to stderr so that stdout carries only
 * the command result (one JSON document under `--json`).
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const stream = options.stream ?? process.stderr;
  const color = options.color ?? false;

  const write = (messageLevel: MessageLevel, message: string): void => {
    if (rank[messageLevel] > rank[level]) return;
    const { label, ansi } = style[messageLevel];
    const prefix = color ? `${ansi}${label}\x1b[0m` : label;
    stream.write(`${prefix} ${message}\n`);
  };

  return {
    level,
    error: (message) => write('error', message),
    warn: (message) => write('warn', message),
    info: (message) => write('info', message),
    debug: (message) => write('debug', message),
  };
}

/** Whether ANSI color should be used on the given stream, honouring NO_COLOR/FORCE_COLOR. */
export function shouldUseColor(
  stream: { isTTY?: boolean } = process.stderr,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const noColor = env.NO_COLOR ?? '';
  const forceColor = env.FORCE_COLOR ?? '';
  if (noColor !== '') return false;
  if (forceColor !== '') return forceColor !== '0';
  return stream.isTTY === true;
}
