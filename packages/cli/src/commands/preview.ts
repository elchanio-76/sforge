import { resolve } from 'node:path';
import type { Command } from 'commander';
import { openBrowser } from '../browser.js';
import { type Runtime, action } from '../command.js';
import { displayPath } from '../paths.js';
import { loadProjectConfig } from '../project.js';
import { type ServerFlags, addServerOptions, hostFrom } from '../server-options.js';

export function registerPreviewCommand(program: Command, runtime: Runtime): void {
  addServerOptions(
    program
      .command('preview')
      .description('Serve an existing build (no rebuilding), as it will be served in production')
      .option('--dir <dir>', 'directory to serve (default: build.outDir)'),
    4322,
  ).action(
    action(runtime, async (ctx, { options }) => {
      const { startPreviewServer } = await import('@staticforge/dev-server');
      const flags = options as unknown as ServerFlags & { dir?: string };
      const { config, rootDir } = await loadProjectConfig(ctx);
      const dir = resolve(
        flags.dir !== undefined ? ctx.cwd : rootDir,
        flags.dir ?? config.build.outDir,
      );
      const server = await startPreviewServer({
        dir,
        host: hostFrom(flags, ctx.logger),
        port: flags.port,
        trailingSlash: config.build.trailingSlash,
      });
      if (flags.open && ctx.interactive) openBrowser(server.url);

      const stopped = new Promise<void>((resolveStop) => {
        ctx.io.onShutdown(() => void server.close().then(resolveStop));
      });
      return {
        data: { url: server.url, host: server.host, port: server.port, dir },
        text: `Serving ${displayPath(ctx.cwd, dir)} at ${server.url}\nPress Ctrl+C to stop.`,
        wait: stopped,
      };
    }),
  );
}
