import { Command, CommanderError } from 'commander';
import { ErrorCode, ExitCode } from '@staticforge/core';
import type { Runtime } from './command.js';
import { registerConfigCommands } from './commands/config.js';
import { registerSchemaCommand } from './commands/schema.js';
import { registerVersionCommand } from './commands/version.js';
import { type Io, processIo } from './io.js';
import { OUTPUT_SCHEMA_VERSION } from './output.js';
import { VERSION } from './version.js';

export { defineConfig } from '@staticforge/core';
export type { SforgeConfig, SforgeConfigInput } from '@staticforge/core';

export function createProgram(runtime: Runtime): Command {
  const { io } = runtime;
  const program = new Command('sforge')
    .description('staticforge: build, check, preview and deploy accessible static sites')
    .version(VERSION, '-V, --version')
    .option('--json', 'write a single JSON document to stdout (logs go to stderr)')
    .option('-q, --quiet', 'only log errors')
    .option('-v, --verbose', 'log debug output')
    .option('--cwd <dir>', 'run as if started in <dir>')
    .option('-c, --config <path>', 'path to the config file')
    .option('--no-color', 'disable colored output')
    .option('--non-interactive', 'never prompt (implied when CI is set or stdin is not a TTY)')
    .showSuggestionAfterError()
    .exitOverride()
    .configureOutput({
      writeOut: (s) => io.stdout.write(s),
      writeErr: (s) => io.stderr.write(s),
    });

  // Subcommands created below inherit exitOverride and output settings.
  registerConfigCommands(program, runtime);
  registerSchemaCommand(program, runtime);
  registerVersionCommand(program, runtime);

  return program;
}

/** Run the CLI and return the process exit code. */
export async function run(argv: string[], io: Io = processIo()): Promise<ExitCode> {
  const runtime: Runtime = { io, exitCode: ExitCode.Ok };
  const program = createProgram(runtime);

  try {
    await program.parseAsync(argv);
    return runtime.exitCode;
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
    // --help and --version exit through here with code 0.
    if (error.exitCode === 0) return ExitCode.Ok;
    // Commander has already printed the usage error to stderr.
    if (argv.includes('--json')) {
      io.stdout.write(
        `${JSON.stringify(
          {
            schemaVersion: OUTPUT_SCHEMA_VERSION,
            command: '',
            ok: false,
            error: { code: ErrorCode.Usage, message: error.message.replace(/^error: /, '') },
          },
          null,
          2,
        )}\n`,
      );
    }
    return ExitCode.Usage;
  }
}
