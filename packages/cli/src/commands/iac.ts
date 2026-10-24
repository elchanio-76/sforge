import { Argument, type Command } from 'commander';
import { type PassthroughCommand, passthrough, prepareWorkspace } from '@staticforge/iac';
import { type Runtime, action } from '../command.js';
import { targetContext } from '../cloud.js';
import { displayPath } from '../paths.js';
import { loadProjectConfig } from '../project.js';
import { localStateFrom } from './provision.js';

const ENGINE_COMMANDS: PassthroughCommand[] = [
  'init',
  'plan',
  'apply',
  'output',
  'validate',
  'state',
  'show',
  'import',
  'console',
];

export function registerIacCommand(program: Command, runtime: Runtime): void {
  program
    .command('iac')
    .description(
      "Low-level access to a target's generated OpenTofu/Terraform workspace (.sforge/iac/<target>/)",
    )
    .addArgument(
      new Argument('<command>', 'path, or an engine command').choices(['path', ...ENGINE_COMMANDS]),
    )
    .argument('<target>', 'target name from the config')
    .argument('[args...]', 'extra engine arguments, after --')
    .option('--local-state', 'use the state in .sforge/iac/<target>/')
    .option('--force-local-state', 'allow --local-state in CI')
    .addHelpText(
      'after',
      '\nExamples:\n  sforge iac path staging\n  sforge iac plan staging -- -target=module.site.aws_s3_bucket.site\n  sforge iac output staging -- -json',
    )
    .action(
      action<Record<string, unknown>>(runtime, async (ctx, { args, options }) => {
        const [command, name, extra] = args as [string, string, string[]];
        const loaded = await loadProjectConfig(ctx);
        const target = targetContext(
          runtime,
          ctx,
          loaded,
          name,
          localStateFrom(options, ctx.io.env),
        );
        if (command === 'path') {
          const { ws } = await prepareWorkspace(target.iac);
          return { data: { target: name, workspace: ws.dir, engine: ws.engine }, text: ws.dir };
        }
        // Engine output is for humans: it goes to stderr, keeping stdout for the result.
        const result = await passthrough({
          ...target.iac,
          command: command as PassthroughCommand,
          args: extra ?? [],
          onStdout: (chunk) => (ctx.json ? ctx.io.stderr : ctx.io.stdout).write(chunk),
          onStderr: (chunk) => ctx.io.stderr.write(chunk),
          interactive: ctx.interactive,
        });
        // plan -detailed-exitcode uses 2 for "changes"; anything else non-zero failed.
        const failed =
          result.exitCode !== 0 &&
          !(command === 'plan' && result.exitCode === 2 && extra?.includes('-detailed-exitcode'));
        return {
          ok: !failed,
          data: {
            target: name,
            command,
            exitCode: result.exitCode,
            workspace: result.workspace,
            diagnostics: result.diagnostics,
          },
          ...(failed && {
            text: `${loaded.config.iac.engine} ${command} failed with exit code ${result.exitCode} in ${displayPath(ctx.cwd, result.workspace)}`,
          }),
        };
      }),
    );
}
