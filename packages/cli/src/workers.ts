import { type Command, InvalidArgumentError } from 'commander';
import type { SforgeConfig } from '@staticforge/core';

function parseWorkers(value: string): number | 'auto' {
  if (value === 'auto') return value;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 64) {
    throw new InvalidArgumentError(
      'must be "auto" or an integer from 0 to 64 (0: main thread only)',
    );
  }
  return n;
}

/** `--workers`, shared by the commands that build or check. */
export function addWorkersOption(command: Command): Command {
  return command.option(
    '--workers <n>',
    'worker threads for parsing, rendering and checking (default: build.workers; 0: none)',
    parseWorkers,
  );
}

/** The config with `--workers` applied. */
export function withWorkers(config: SforgeConfig, options: Record<string, unknown>): SforgeConfig {
  const workers = options.workers as number | 'auto' | undefined;
  return workers === undefined ? config : { ...config, build: { ...config.build, workers } };
}
