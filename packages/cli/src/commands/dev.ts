import type { Command } from 'commander';
import type { DevBuildState } from '@staticforge/dev-server';
import { type Diagnostic, type Logger, formatDiagnostic } from '@staticforge/core';
import { openBrowser } from '../browser.js';
import { type Runtime, action } from '../command.js';
import { loadProjectConfig } from '../project.js';
import { type ServerFlags, addServerOptions, hostFrom } from '../server-options.js';
import { VERSION } from '../version.js';
import { addWorkersOption, withWorkers } from '../workers.js';

function logBuild(state: DevBuildState, problems: Diagnostic[], logger: Logger): void {
  if (state.error !== undefined) {
    logger.error(`Build failed: ${state.error.message}`);
    if (state.error.hint !== undefined) logger.info(`hint: ${state.error.hint}`);
    return;
  }
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
    addWorkersOption(
      program
        .command('dev')
        .description(
          'Build and serve the site locally, rebuilding and reloading the browser on changes',
        )
        .option('--drafts', 'include pages marked draft: true'),
    ),
    4321,
  ).action(
    action(runtime, async (ctx, { options }) => {
      const { problemsOf, startDevServer } = await import('@staticforge/dev-server');
      const flags = options as unknown as ServerFlags & { drafts?: boolean };
      const server = await startDevServer({
        loadConfig: async () => {
          const loaded = await loadProjectConfig(ctx);
          return { ...loaded, config: withWorkers(loaded.config, options) };
        },
        host: hostFrom(flags, ctx.logger),
        port: flags.port,
        ...(flags.drafts === true && { drafts: true }),
        generator: `staticforge ${VERSION}`,
        logger: ctx.logger,
        onBuild: (state) => logBuild(state, problemsOf(state), ctx.logger),
      });
      if (flags.open && ctx.interactive) openBrowser(server.url);

      const stopped = new Promise<void>((resolve) => {
        ctx.io.onShutdown(() => {
          ctx.logger.info('Stopping dev server');
          void server.close().then(resolve);
        });
      });
      // The latest build: the first one now, later ones for in-process callers.
      const data = () => {
        const state = server.state;
        return {
          url: server.url,
          host: server.host,
          port: server.port,
          rootDir: server.rootDir,
          build: {
            ok: state.ok,
            summary: state.result?.summary,
            pages: state.result?.pages,
            diagnostics: state.diagnostics,
            error: state.error,
          },
        };
      };
      return {
        ok: true,
        data: data(),
        live: data,
        text: `Dev server running at ${server.url}\nWatching ${server.rootDir} for changes. Press Ctrl+C to stop.`,
        wait: stopped,
      };
    }),
  );
}
