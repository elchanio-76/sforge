import { fileURLToPath } from 'node:url';
import { type LoadedConfig, loadConfig } from '@staticforge/core';
import type { CommandContext } from './context.js';

/** This package's public entry point, as source under tests and compiled in dist/. */
const selfEntry = fileURLToPath(
  new URL(import.meta.url.endsWith('.ts') ? './main.ts' : './main.js', import.meta.url),
);

/**
 * Load the project config for a command. `import ... from 'staticforge'` in a
 * JS/TS config resolves to the running CLI, so projects need not install it.
 */
export function loadProjectConfig(ctx: CommandContext): Promise<LoadedConfig> {
  return loadConfig({
    cwd: ctx.cwd,
    configPath: ctx.configPath,
    aliases: { staticforge: selfEntry },
  });
}

/** Load the config of the project in `dir` (e.g. another checkout of the same repository). */
export function loadProjectConfigAt(dir: string): Promise<LoadedConfig> {
  return loadConfig({ cwd: dir, aliases: { staticforge: selfEntry } });
}
