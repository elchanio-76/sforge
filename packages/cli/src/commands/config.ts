import type { Command } from 'commander';
import { type Runtime, action } from '../command.js';
import { loadProjectConfig } from '../project.js';

export function registerConfigCommands(program: Command, runtime: Runtime): void {
  const config = program.command('config').description('Inspect and validate the project config');

  config
    .command('validate')
    .description('Validate the config file and report problems')
    .action(
      action(runtime, async (ctx) => {
        const loaded = await loadProjectConfig(ctx);
        const targets = Object.keys(loaded.config.targets);
        return {
          data: { valid: true, path: loaded.path, rootDir: loaded.rootDir, targets },
          text: `Config is valid: ${loaded.path}`,
        };
      }),
    );

  config
    .command('show')
    .description('Print the resolved config, with defaults applied')
    .action(
      action(runtime, async (ctx) => {
        const loaded = await loadProjectConfig(ctx);
        return {
          data: { path: loaded.path, config: loaded.config },
          text: JSON.stringify(loaded.config, null, 2),
        };
      }),
    );
}
