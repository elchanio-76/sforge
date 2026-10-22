import type { Command } from 'commander';
import { type Runtime, action } from '../command.js';
import { VERSION } from '../version.js';

export function registerVersionCommand(program: Command, runtime: Runtime): void {
  program
    .command('version')
    .description('Print version information')
    .action(
      action(runtime, async () => ({
        data: {
          version: VERSION,
          node: process.versions.node,
          platform: process.platform,
          arch: process.arch,
        },
        text: `sforge ${VERSION} (node ${process.versions.node}, ${process.platform}-${process.arch})`,
      })),
    );
}
