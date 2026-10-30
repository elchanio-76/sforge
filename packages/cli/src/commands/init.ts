import { Option, type Command } from 'commander';
import { resolve } from 'node:path';
import { type Runtime, action } from '../command.js';
import { displayPath } from '../paths.js';

export function registerInitCommand(program: Command, runtime: Runtime): void {
  program
    .command('init')
    .description('Create a new site: config, starter content and styles')
    .argument('[dir]', 'project directory (created if missing)', '.')
    .option('--title <title>', 'site title (default: from the directory name)')
    .option('--base-url <url>', 'production URL of the site', 'https://example.com')
    .option('--language <tag>', 'BCP 47 language of the content', 'en')
    .addOption(
      new Option('--format <format>', 'config file format')
        .choices(['ts', 'json', 'yaml'])
        .default('ts'),
    )
    .addOption(
      new Option('--provider <provider>', 'add a "staging" deploy target').choices([
        'aws',
        'azure',
        'firebase',
      ]),
    )
    .option('--region <region>', 'AWS region or Azure location for the target')
    .option('--project <id>', 'Google Cloud project ID for a Firebase target')
    .option('--force', 'overwrite existing starter files')
    .action(
      action(runtime, async (ctx, { args, options }) => {
        const { initProject } = await import('@staticforge/build');
        const dir = resolve(ctx.cwd, String(args[0]));
        const result = initProject({
          dir,
          title: options.title as string | undefined,
          baseUrl: options.baseUrl as string,
          language: options.language as string,
          format: options.format as 'ts' | 'json' | 'yaml',
          provider: options.provider as 'aws' | 'azure' | 'firebase' | undefined,
          region: options.region as string | undefined,
          project: options.project as string | undefined,
          force: options.force === true,
        });

        const where = displayPath(ctx.cwd, dir);
        const lines = [
          ...result.created.map((path) => `  created ${path}`),
          ...result.skipped.map((path) => `  skipped ${path} (exists)`),
          '',
          'Next steps:',
          ...(where === '.' ? [] : [`  cd ${where}`]),
          '  sforge dev      # preview at http://127.0.0.1:4321 with live reload',
          '  sforge check    # accessibility and link checks',
          '  sforge build',
        ];
        if (options.baseUrl === 'https://example.com') {
          ctx.logger.warn(
            'site.baseUrl is https://example.com; set it to your real URL before deploying',
          );
        }
        return {
          data: result,
          text: `Initialized staticforge project in ${where}\n${lines.join('\n')}`,
        };
      }),
    );
}
