import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Option, type Command } from 'commander';
import {
  type CheckResult,
  checkSite,
  formatJunit,
  formatPretty,
  formatSarif,
} from '@staticforge/checker';
import { ErrorCode, SforgeError, shouldUseColor } from '@staticforge/core';
import { type Runtime, action } from '../command.js';
import { displayPath } from '../paths.js';
import { loadProjectConfig } from '../project.js';
import { VERSION } from '../version.js';

type Format = 'pretty' | 'json' | 'sarif' | 'junit';

/** Directory of the enclosing git repository, if any. */
function gitRoot(dir: string): string | undefined {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return d;
    if (dirname(d) === d) return undefined;
  }
}

const truthy = (value: string | undefined): boolean =>
  value !== undefined && value !== '' && value !== 'false' && value !== '0';

export function registerCheckCommand(program: Command, runtime: Runtime): void {
  program
    .command('check')
    .description(
      'Build the site to a temporary directory and check it for accessibility and correctness',
    )
    .option('--fix', 'apply safe fixes to the source files, then check again')
    .option('--dry-run', 'with --fix: print the fixes as a diff instead of applying them')
    .option('--headless', 'run rendered checks in headless Chromium (default: check.headless)')
    .option('--no-headless', 'skip rendered checks')
    .option('--pages <globs...>', 'only check pages whose URL or source matches, e.g. "/blog/**"')
    .addOption(
      new Option('--format <format>', 'report format')
        .choices(['pretty', 'json', 'sarif', 'junit'])
        .default('pretty'),
    )
    .option('--output <file>', 'write the report to a file instead of stdout')
    .addOption(
      new Option(
        '--fail-on <severity>',
        'exit 1 on problems at or above (default: check.failOn)',
      ).choices(['error', 'warning']),
    )
    .option('--drafts', 'include pages marked draft: true')
    .action(
      action(runtime, async (ctx, { options }) => {
        const format = options.format as Format;
        const output = options.output as string | undefined;
        if (options.dryRun === true && options.fix !== true) {
          throw new SforgeError(ErrorCode.Usage, '--dry-run requires --fix');
        }
        if (ctx.json && format !== 'pretty' && format !== 'json' && output === undefined) {
          throw new SforgeError(
            ErrorCode.Usage,
            `--format ${format} and --json both write to stdout`,
            {
              hint: `Write the ${format} report to a file with --output <file>.`,
            },
          );
        }

        const loaded = await loadProjectConfig(ctx);
        const { config, rootDir } = loaded;
        const env = ctx.io.env;
        const headless = options.headless as boolean | undefined;
        const result: CheckResult = await checkSite({
          rootDir,
          config,
          ...(headless !== undefined && { headless }),
          // An explicit --headless, or CI, must not silently skip rendered checks.
          requireBrowser: headless === true || truthy(env.CI),
          ...(env.SFORGE_CHROMIUM_PATH && { executablePath: env.SFORGE_CHROMIUM_PATH }),
          ...(options.pages !== undefined && { pages: options.pages as string[] }),
          ...(options.fix === true && { fix: options.dryRun === true ? 'dry-run' : 'apply' }),
          ...(options.failOn !== undefined && { failOn: options.failOn as 'error' | 'warning' }),
          ...(options.drafts === true && { drafts: true }),
          generator: `staticforge ${VERSION}`,
          logger: ctx.logger,
        });

        const render = (as: Format, color: boolean): string => {
          switch (as) {
            case 'json':
              return JSON.stringify(result, null, 2);
            case 'sarif': {
              const repo = gitRoot(rootDir);
              const prefix = repo === undefined ? '' : relative(repo, rootDir).split(sep).join('/');
              return JSON.stringify(
                formatSarif(result, {
                  toolVersion: VERSION,
                  uriPrefix: prefix === '' ? '' : `${prefix}/`,
                  fallbackFile: relative(rootDir, loaded.path).split(sep).join('/'),
                }),
                null,
                2,
              );
            }
            case 'junit':
              return formatJunit(result);
            default:
              return formatPretty(result, { color });
          }
        };

        const color = ctx.color && shouldUseColor(ctx.io.stdout, env);
        let text: string;
        if (output !== undefined) {
          const path = resolve(ctx.cwd, output);
          writeFileSync(path, `${render(format, false)}\n`);
          text = `${formatPretty(result, { color })}\nWrote ${format} report to ${displayPath(ctx.cwd, path)}`;
        } else {
          text = render(format, color);
        }
        if (result.fixes?.applied === false && format === 'pretty' && output === undefined) {
          text = `${result.fixes.diff}\n${text}`;
        }
        return { ok: result.ok, data: result, text };
      }),
    );
}
