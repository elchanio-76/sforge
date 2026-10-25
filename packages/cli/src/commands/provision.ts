import type { Command } from 'commander';
import { ErrorCode, SforgeError } from '@staticforge/core';
import type { ProvisionResult } from '@staticforge/iac';
import { type Runtime, action } from '../command.js';
import { confirmer, formatPlan, targetContext, truthy } from '../cloud.js';
import { displayPath } from '../paths.js';
import { loadProjectConfig } from '../project.js';

interface StateFlags {
  localState?: boolean;
  forceLocalState?: boolean;
}

/** --local-state is for experiments: refused in CI unless forced. */
export function localStateFrom(flags: StateFlags, env: NodeJS.ProcessEnv): boolean {
  if (flags.localState !== true) return false;
  if (truthy(env.CI) && flags.forceLocalState !== true) {
    throw new SforgeError(ErrorCode.Usage, '--local-state is refused in CI', {
      hint: 'Local state is lost with the runner. Use the remote backend, or pass --force-local-state.',
    });
  }
  return true;
}

function describe(result: ProvisionResult, cwd: string): string {
  const lines: string[] = [];
  if (result.bootstrap) {
    lines.push(
      result.bootstrap.created
        ? `Created the state backend ${result.bootstrap.description}`
        : `State backend: ${result.bootstrap.description}`,
    );
  }
  lines.push(formatPlan(result.plan));
  lines.push(...result.notices);
  if (result.pending) {
    lines.push(`Run \`sforge provision ${result.target}\` again once the records resolve.`);
  } else if (result.applied) {
    lines.push(
      `Applied: ${result.apply?.add ?? 0} added, ${result.apply?.change ?? 0} changed, ${result.apply?.remove ?? 0} destroyed.`,
    );
  }
  const outputs = result.outputs ?? {};
  if (typeof outputs.url === 'string') lines.push(`URL: ${outputs.url}`);
  const dns = outputs.dns_records as { name: string; type: string; value: string }[] | undefined;
  if (dns && dns.length > 0 && result.applied) {
    lines.push('Point your DNS at CloudFront (skip if Route 53 manages the zone):');
    lines.push(...dns.map((r) => `  ${r.name} ${r.type} ${r.value}`));
  }
  if (typeof outputs.ci_role_arn === 'string') lines.push(`CI deploy role: ${outputs.ci_role_arn}`);
  lines.push(`Workspace: ${displayPath(cwd, result.workspace)}`);
  return lines.join('\n');
}

export function registerProvisionCommands(program: Command, runtime: Runtime): void {
  program
    .command('provision')
    .description('Create or update the infrastructure of a target with OpenTofu/Terraform')
    .argument('<target>', 'target name from the config')
    .option('--diff', 'only show what would change (plan), change nothing')
    .option('--bootstrap-state', "create the target's remote state backend first, if missing")
    .option('--local-state', 'keep state in .sforge/iac/<target>/ (experiments only)')
    .option('--force-local-state', 'allow --local-state in CI')
    .option('--no-wait', 'create the certificate, print its DNS records and stop')
    .option('-y, --yes', 'apply without asking')
    .action(
      action(runtime, async (ctx, { args, options }) => {
        const loaded = await loadProjectConfig(ctx);
        const target = await targetContext(
          runtime,
          ctx,
          loaded,
          args[0] as string,
          localStateFrom(options, ctx.io.env),
        );
        const { provision } = await import('@staticforge/iac');
        const result = await provision({
          ...target.iac,
          diff: options.diff === true,
          bootstrapState: options.bootstrapState === true,
          noWait: options.wait === false,
          confirm: confirmer(ctx, options.yes === true),
        });
        return { data: result, text: describe(result, ctx.cwd) };
      }),
    );

  program
    .command('status')
    .description("Show a target's current version and URL, and detect infrastructure drift")
    .argument('<target>', 'target name from the config')
    .option('--local-state', 'use the state in .sforge/iac/<target>/')
    .option('--force-local-state', 'allow --local-state in CI')
    .action(
      action(runtime, async (ctx, { args, options }) => {
        const loaded = await loadProjectConfig(ctx);
        const target = await targetContext(
          runtime,
          ctx,
          loaded,
          args[0] as string,
          localStateFrom(options, ctx.io.env),
        );
        const { detectDrift } = await import('@staticforge/iac');
        const drift = await detectDrift(target.iac);
        let versionId: string | null = null;
        try {
          const deployer = target.provider.createDeployer({
            rootDir: loaded.rootDir,
            config: loaded.config,
            targetName: target.targetName,
            target: target.target,
            outputs: drift.outputs,
            env: ctx.io.env,
            logger: ctx.logger,
          });
          versionId = (await deployer.current()).versionId;
        } catch (error) {
          // Not provisioned yet, or not deployable: drift is still useful.
          if (!(error instanceof SforgeError) || error.code !== ErrorCode.NotProvisioned)
            throw error;
        }
        const url = typeof drift.outputs.url === 'string' ? drift.outputs.url : undefined;
        const lines = [
          `${target.targetName} (${target.target.provider}): ${url ?? 'not provisioned'}`,
          `Active version: ${versionId ?? 'none'}`,
          drift.drifted
            ? `Drift detected:\n${drift.drift.map((d) => `  ! ${d.address} (${d.action})`).join('\n') || '  (the plan has changes)'}`
            : 'No drift: the infrastructure matches the last apply.',
        ];
        // Drift is a finding: exit 1 so CI can alert on it.
        return { ok: !drift.drifted, data: { ...drift, url, versionId }, text: lines.join('\n') };
      }),
    );

  program
    .command('destroy')
    .description('Delete every resource of a target, including its deployed content')
    .argument('<target>', 'target name from the config')
    .requiredOption('--confirm <target>', 'repeat the target name to confirm')
    .option('--local-state', 'use the state in .sforge/iac/<target>/')
    .option('--force-local-state', 'allow --local-state in CI')
    .action(
      action(runtime, async (ctx, { args, options }) => {
        const name = args[0] as string;
        if (options.confirm !== name) {
          throw new SforgeError(
            ErrorCode.ConfirmationRequired,
            `--confirm must repeat the target name "${name}"`,
          );
        }
        const loaded = await loadProjectConfig(ctx);
        const target = await targetContext(
          runtime,
          ctx,
          loaded,
          name,
          localStateFrom(options, ctx.io.env),
        );
        const { destroy } = await import('@staticforge/iac');
        const result = await destroy(target.iac);
        return {
          data: result,
          text: result.destroyed
            ? `Destroyed ${result.plan.remove} resources of "${name}". The state backend was kept.`
            : `Nothing to destroy for "${name}".`,
        };
      }),
    );
}
