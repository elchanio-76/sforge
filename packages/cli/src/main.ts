import { Command, CommanderError } from 'commander';
import { ErrorCode, ExitCode } from '@staticforge/core';
import type { Runtime } from './command.js';
import { registerBuildCommand } from './commands/build.js';
import { registerCheckCommand } from './commands/check.js';
import { registerCiCommand } from './commands/ci.js';
import { registerConfigCommands } from './commands/config.js';
import { registerDeployCommands } from './commands/deploy.js';
import { registerDevCommand } from './commands/dev.js';
import { registerIacCommand } from './commands/iac.js';
import { registerInitCommand } from './commands/init.js';
import { registerMcpCommand } from './commands/mcp.js';
import { registerNewCommand } from './commands/new.js';
import { registerPreviewCommand } from './commands/preview.js';
import { registerProvisionCommands } from './commands/provision.js';
import { registerSchemaCommand } from './commands/schema.js';
import { registerVersionCommand } from './commands/version.js';
import { type Io, processIo } from './io.js';
import { type Envelope, OUTPUT_SCHEMA_VERSION } from './output.js';
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
    .option('-c, --config <path>', 'config file, or the project directory containing it')
    .option('--no-color', 'disable colored output')
    .option('--non-interactive', 'never prompt (implied when CI is set or stdin is not a TTY)')
    .showSuggestionAfterError()
    .exitOverride()
    .configureOutput({
      writeOut: (s) => io.stdout.write(s),
      writeErr: (s) => io.stderr.write(s),
    });

  // Subcommands created below inherit exitOverride and output settings.
  registerInitCommand(program, runtime);
  registerNewCommand(program, runtime);
  registerBuildCommand(program, runtime);
  registerCheckCommand(program, runtime);
  registerDevCommand(program, runtime);
  registerPreviewCommand(program, runtime);
  registerProvisionCommands(program, runtime);
  registerIacCommand(program, runtime);
  registerDeployCommands(program, runtime);
  registerConfigCommands(program, runtime);
  registerCiCommand(program, runtime);
  registerSchemaCommand(program, runtime);
  registerVersionCommand(program, runtime);
  registerMcpCommand(program, runtime);

  return program;
}

/** Run the CLI and return the process exit code. */
export async function run(
  argv: string[],
  io: Io = processIo(),
  hooks: Pick<Runtime, 'providers' | 'dns' | 'onResult'> = {},
): Promise<ExitCode> {
  const runtime: Runtime = { io, exitCode: ExitCode.Ok, ...hooks };
  const program = createProgram(runtime);

  try {
    await program.parseAsync(argv);
    return runtime.exitCode;
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
    // --help and --version exit through here with code 0.
    if (error.exitCode === 0) return ExitCode.Ok;
    // Commander has already printed the usage error to stderr.
    const envelope: Envelope = {
      schemaVersion: OUTPUT_SCHEMA_VERSION,
      command: '',
      ok: false,
      error: {
        code: ErrorCode.Usage,
        // A command group without a subcommand prints its help and fails with "(outputHelp)".
        message:
          error.code === 'commander.help'
            ? 'Missing subcommand; --help lists them'
            : error.message.replace(/^error: /, ''),
      },
    };
    runtime.onResult?.({ envelope });
    if (argv.includes('--json')) io.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    return ExitCode.Usage;
  }
}
