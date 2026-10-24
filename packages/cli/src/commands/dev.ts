import type { Command } from 'commander';
import { type DevBuildState, problemsOf, startDevServer } from '@staticforge/dev-server';
import { type Logger, formatDiagnostic } from '@staticforge/core';
import { openBrowser } from '../browser.js';
import { type Runtime, action } from '../command.js';
import { loadProjectConfig } from '../project.js';
import { type ServerFlags, addServerOptions, hostFrom } from '../server-options.js';
import { VERSION } from '../version.js';

function logBuild(state: DevBuildState, logger: Logger): void {
  if (state.error !== undefined) {
    logger.error(`Build failed: ${state.error.message}`);
    if (state.error.hint !== undefined) logger.info(`hint: ${state.error.hint}`);
    return;
  }
  const problems = problemsOf(state);
  for (const d of problems) {
    if (d.severity === 'error') logger.error(formatDiagnostic(d));
    else logger.warn(formatDiagnostic(d));
  }
  const error = problems.filter((d) => d.severity === 'error').length;
  const warning = problems.length - error;
  const trigger =
    state.changed.length > 0
      ? ` (${state.changed.slice(0, 3).join(', ')}${state.changed.length > 3 ? ', …' : ''})`
      : '';
  logger.info(
    `Built in ${state.result?.durationMs ?? 0}ms${trigger}: ${error} errors, ${warning} warnings`,
  );
}

export function registerDevCommand(program: Command, runtime: Runtime): void {
  addServerOptions(
    program
      .command('dev')
      .description(
        'Build and serve the site locally, rebuilding and reloading the browser on changes',
      )
      .option('--drafts', 'include pages marked draft: true'),
    4321,
  ).action(
    action(runtime, async (ctx, { options }) => {
      const flags = options as unknown as ServerFlags & { drafts?: boolean };
      const server = await startDevServer({
        loadConfig: () => loadProjectConfig(ctx),
        host: hostFrom(flags, ctx.logger),
        port: flags.port,
        ...(flags.drafts === true && { drafts: true }),
        generator: `staticforge ${VERSION}`,
        logger: ctx.logger,
        onBuild: (state) => logBuild(state, ctx.logger),
      });
      if (flags.open && ctx.interactive) openBrowser(server.url);

      const stopped = new Promise<void>((resolve) => {
        ctx.io.onShutdown(() => {
          ctx.logger.info('Stopping dev server');
          void server.close().then(resolve);
        });
      });
      const first = server.state;
      return {
        ok: true,
        data: {
          url: server.url,
          host: server.host,
          port: server.port,
          rootDir: server.rootDir,
          build: {
            ok: first.ok,
            summary: first.result?.summary,
            pages: first.result?.pages,
            diagnostics: first.diagnostics,
            error: first.error,
          },
        },
        text: `Dev server running at ${server.url}\nWatching ${server.rootDir} for changes. Press Ctrl+C to stop.`,
        wait: stopped,
      };
    }),
  );
}
