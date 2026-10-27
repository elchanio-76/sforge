import type { Command } from 'commander';
import { ErrorCode, SforgeError } from '@staticforge/core';
import { targetOutputs } from '@staticforge/iac';
import type { UserAdmin } from '@staticforge/provider-api';
import { type Runtime, action } from '../command.js';
import { type TargetContext, confirmAction, targetContext } from '../cloud.js';
import type { CommandContext } from '../context.js';
import { loadProjectConfig } from '../project.js';

/** The user admin of a private target; SF_UNSUPPORTED for public ones. */
async function usersOf(
  runtime: Runtime,
  ctx: CommandContext,
  name: string,
): Promise<{ target: TargetContext; users: UserAdmin }> {
  const loaded = await loadProjectConfig(ctx);
  const target = await targetContext(runtime, ctx, loaded, name);
  if (target.target.auth === undefined || target.provider.createUserAdmin === undefined) {
    throw new SforgeError(ErrorCode.Unsupported, `Target "${name}" is not private`, {
      hint: `Set targets.${name}.auth and run \`sforge provision ${name}\` to require sign-in.`,
    });
  }
  const outputs = await targetOutputs(target.iac);
  const users = target.provider.createUserAdmin({
    rootDir: loaded.rootDir,
    config: loaded.config,
    targetName: name,
    target: target.target,
    outputs,
    env: ctx.io.env,
    logger: ctx.logger,
  });
  return { target, users };
}

function expiresHours(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const hours = Number(value);
  if (!Number.isInteger(hours) || hours < 1 || hours > 168) {
    throw new SforgeError(ErrorCode.Usage, '--expires must be a whole number of hours, 1 to 168');
  }
  return hours;
}

export function registerUsersCommand(program: Command, runtime: Runtime): void {
  const users = program
    .command('users')
    .description(
      'Manage who may sign in to a private target (targets.<name>.auth); uses your own cloud sign-in, never CI',
    );

  users
    .command('list')
    .description('List the users of a private target')
    .argument('<target>', 'target name from the config')
    .action(
      action(runtime, async (ctx, { args }) => {
        const name = args[0] as string;
        const { target, users: admin } = await usersOf(runtime, ctx, name);
        const list = await admin.list();
        const rows = list.map(
          (u) =>
            `${u.name}${u.provider ? ` (${u.provider})` : ''}` +
            (u.status ? `  ${u.status}` : '') +
            (u.enabled === false ? '  disabled' : ''),
        );
        return {
          data: { target: name, provider: target.target.provider, users: list },
          text: rows.length > 0 ? rows.join('\n') : `"${name}" has no users yet.`,
        };
      }),
    );

  users
    .command('invite')
    .description('Invite a user: AWS emails a temporary password; Azure returns a link to pass on')
    .argument('<target>', 'target name from the config')
    .argument('<user>', 'email address (GitHub user name with --provider github)')
    .option('--provider <provider>', 'Azure sign-in provider: aad or github (default: the first)')
    .option('--expires <hours>', 'hours the Azure invitation link stays valid (1-168, default 168)')
    .action(
      action(runtime, async (ctx, { args, options }) => {
        const name = args[0] as string;
        const { users: admin } = await usersOf(runtime, ctx, name);
        const hours = expiresHours(options.expires);
        const result = await admin.invite({
          user: args[1] as string,
          ...(options.provider !== undefined && { provider: options.provider as string }),
          ...(hours !== undefined && { expiresHours: hours }),
        });
        const text = result.emailed
          ? `Invited ${result.user}: Cognito emails a temporary password to sign in with.`
          : [
              `Invitation for ${result.user}${result.provider ? ` (${result.provider})` : ''}` +
                (result.expiresAt ? `, valid until ${result.expiresAt}` : '') +
                '. Send them this link; they sign in with that account:',
              `  ${result.invitationUrl ?? '(no link returned)'}`,
            ].join('\n');
        return { data: { target: name, ...result }, text };
      }),
    );

  users
    .command('remove')
    .description('Remove a user (their current sign-in lasts until it expires)')
    .argument('<target>', 'target name from the config')
    .argument('<user>', 'email address or GitHub user name')
    .option('--provider <provider>', 'Azure sign-in provider of the user: aad or github')
    .option('-y, --yes', 'remove without asking')
    .action(
      action(runtime, async (ctx, { args, options }) => {
        const name = args[0] as string;
        const user = args[1] as string;
        const { target, users: admin } = await usersOf(runtime, ctx, name);
        await confirmAction(ctx, options.yes === true, `Remove ${user} from "${name}"?`);
        const removed = await admin.remove(user, options.provider as string | undefined);
        const config = target.target;
        const lasts =
          config.provider === 'aws' && config.auth !== undefined
            ? ` Their sign-in on the site lasts up to ${config.auth.sessionHours} hours; \`sforge users revoke-sessions ${name}\` ends every sign-in now.`
            : '';
        return {
          data: { target: name, user, removed },
          text: removed
            ? `Removed ${user} from "${name}".${lasts}`
            : `${user} is not a user of "${name}".`,
        };
      }),
    );

  users
    .command('revoke-sessions')
    .description('Sign everyone out of a private AWS target by replacing its session key')
    .argument('<target>', 'target name from the config')
    .option('-y, --yes', 'revoke without asking')
    .action(
      action(runtime, async (ctx, { args, options }) => {
        const name = args[0] as string;
        const { users: admin } = await usersOf(runtime, ctx, name);
        if (admin.revokeSessions === undefined) {
          throw new SforgeError(
            ErrorCode.Unsupported,
            `"${name}" cannot revoke sign-ins: Static Web Apps keeps its own sessions`,
            { hint: 'Remove the user instead (`sforge users remove`).' },
          );
        }
        await confirmAction(ctx, options.yes === true, `Sign everyone out of "${name}"?`);
        await admin.revokeSessions();
        return {
          data: { target: name, revoked: true },
          text: `Every sign-in to "${name}" has ended; users sign in again (edges update within minutes).`,
        };
      }),
    );
}
