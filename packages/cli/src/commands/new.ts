import { Argument, Option, type Command } from 'commander';
import { newContent } from '@staticforge/build';
import { type Runtime, action } from '../command.js';
import { loadProjectConfig } from '../project.js';

export function registerNewCommand(program: Command, runtime: Runtime): void {
  program
    .command('new')
    .description('Create a page or blog post with front-matter')
    .addArgument(new Argument('<kind>', 'what to create').choices(['page', 'post']))
    .argument(
      '<path>',
      'path inside content/, e.g. "about" or "guides/setup" (posts default to blog/)',
    )
    .option('--title <title>', 'title (default: from the path)')
    .addOption(
      new Option('--format <format>', 'source format').choices(['md', 'html']).default('md'),
    )
    .option('--draft', 'mark as draft (excluded from builds unless --drafts)')
    .option('--force', 'overwrite an existing file')
    .action(
      action(runtime, async (ctx, { args, options }) => {
        const { config, rootDir } = await loadProjectConfig(ctx);
        const result = newContent({
          rootDir,
          kind: args[0] as 'page' | 'post',
          path: String(args[1]),
          title: options.title as string | undefined,
          format: options.format as 'md' | 'html',
          draft: options.draft === true,
          force: options.force === true,
          urls: config.build,
        });
        return { data: result, text: `Created ${result.file} (${result.url})` };
      }),
    );
}
