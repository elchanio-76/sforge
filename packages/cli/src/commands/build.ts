import type { Command } from 'commander';
import { formatDiagnostic } from '@staticforge/core';
import { type Runtime, action } from '../command.js';
import { displayPath } from '../paths.js';
import { loadProjectConfig } from '../project.js';
import { VERSION } from '../version.js';
import { addWorkersOption, withWorkers } from '../workers.js';

export function registerBuildCommand(program: Command, runtime: Runtime): void {
  addWorkersOption(
    program
      .command('build')
      .description('Build the site into the output directory')
      .option('--drafts', 'include pages marked draft: true')
      .option('--out <dir>', 'output directory (default: build.outDir)')
      .option('--base-url <url>', 'site URL for canonical links (default: site.baseUrl)'),
  ).action(
    action(runtime, async (ctx, { options }) => {
      const { buildSite } = await import('@staticforge/build');
      const loaded = await loadProjectConfig(ctx);
      const { rootDir } = loaded;
      const config = withWorkers(loaded.config, options);
      const result = await buildSite({
        rootDir,
        config,
        drafts: options.drafts === true ? true : undefined,
        outDir: options.out as string | undefined,
        baseUrl: options.baseUrl as string | undefined,
        generator: `staticforge ${VERSION}`,
        logger: ctx.logger,
      });

      if (!ctx.json) {
        for (const d of result.diagnostics) {
          const line = formatDiagnostic(d);
          if (d.severity === 'error') ctx.logger.error(line);
          else if (d.severity === 'warning') ctx.logger.warn(line);
          else ctx.logger.info(line);
          if (d.hint !== undefined) ctx.logger.debug(`  hint: ${d.hint}`);
        }
      }

      const { error, warning } = result.summary;
      const outDir = displayPath(ctx.cwd, result.outDir);
      return {
        ok: result.ok,
        data: result,
        text:
          `Built ${result.pages.length} page${result.pages.length === 1 ? '' : 's'} ` +
          `(${result.fileCount} files) into ${outDir} in ${result.durationMs}ms: ` +
          `${error} error${error === 1 ? '' : 's'}, ${warning} warning${warning === 1 ? '' : 's'}` +
          (result.drafts.skipped.length > 0
            ? `, ${result.drafts.skipped.length} draft(s) skipped`
            : ''),
      };
    }),
  );
}
