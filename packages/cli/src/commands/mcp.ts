import type { Command } from 'commander';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { Runtime } from '../command.js';
import { type GlobalOptions, createContext } from '../context.js';
import { createSforgeMcp } from '../mcp/server.js';

/** Global options of `sforge mcp` that every tool call inherits. */
function inheritedArgs(opts: GlobalOptions): string[] {
  return [
    ...(opts.config !== undefined ? ['--config', opts.config] : []),
    ...(opts.quiet === true ? ['--quiet'] : []),
    ...(opts.verbose === true ? ['--verbose'] : []),
  ];
}

export function registerMcpCommand(program: Command, runtime: Runtime): void {
  program
    .command('mcp')
    .description(
      'Serve the sforge commands to AI agents as Model Context Protocol tools (stdio transport)',
    )
    .option('--allow-infra', 'also offer the provision and destroy tools')
    .action(async (_options: unknown, command: Command) => {
      const ctx = createContext(command, runtime.io);
      // stdout carries the protocol: anything a library prints goes to stderr instead.
      console.log = console.info = console.debug = console.error;
      // Imported here: main.ts registers this command, so a static import would be a cycle.
      const { run } = await import('../main.js');
      const mcp = createSforgeMcp({
        run,
        cwd: ctx.cwd,
        globalArgs: inheritedArgs(command.optsWithGlobals<GlobalOptions>()),
        env: ctx.io.env,
        allowInfra: command.opts().allowInfra === true,
        log: (line) => ctx.io.stderr.write(`${line}\n`),
      });
      const handle = serveStdio(() => mcp.createServer(), {
        onerror: (error) => ctx.logger.error(`MCP: ${error.message}`),
      });
      ctx.logger.debug(`sforge MCP server ready for ${ctx.cwd}`);

      // Serve until the client closes stdin, or until SIGINT/SIGTERM.
      await new Promise<void>((resolve) => {
        process.stdin.once('end', resolve);
        process.stdin.once('close', resolve);
        ctx.io.onShutdown(resolve);
      });
      await handle.close();
      await mcp.close();
    });
}
