import {
  type DnsConfig,
  type LoadedConfig,
  type TargetConfig,
  ErrorCode,
  SforgeError,
  getTarget,
} from '@staticforge/core';
import {
  type Confirm,
  type DnsProfile,
  type IacRunOptions,
  type PlanSummary,
  targetOutputs,
} from '@staticforge/iac';
import type { Deployer, Provider } from '@staticforge/provider-api';
import type { Runtime } from './command.js';
import type { CommandContext } from './context.js';
import { loadProjectConfigAt } from './project.js';

/**
 * The provider of a target; tests inject fakes through the runtime. Providers
 * are loaded on demand: their cloud SDKs would slow down every other command.
 */
export async function providerFor(runtime: Runtime, target: TargetConfig): Promise<Provider> {
  const injected = runtime.providers?.[target.provider];
  if (injected !== undefined) return injected;
  return target.provider === 'aws'
    ? (await import('@staticforge/aws')).createAwsProvider()
    : (await import('@staticforge/azure')).createAzureProvider();
}

/** The DNS provider of a target's `dns`, loaded on demand like the cloud providers. */
export async function dnsProfileFor(runtime: Runtime, dns: DnsConfig): Promise<DnsProfile> {
  const injected = runtime.dns?.[dns.provider];
  if (injected !== undefined) return injected;
  return (await import('@staticforge/cloudflare')).createCloudflareDns();
}

export interface TargetContext {
  loaded: LoadedConfig;
  targetName: string;
  target: TargetConfig;
  provider: Provider;
  iac: IacRunOptions;
}

export async function targetContext(
  runtime: Runtime,
  ctx: CommandContext,
  loaded: LoadedConfig,
  targetName: string,
  localState = false,
): Promise<TargetContext> {
  const target = getTarget(loaded.config, targetName);
  const provider = await providerFor(runtime, target);
  const dns = target.dns === undefined ? undefined : await dnsProfileFor(runtime, target.dns);
  return {
    loaded,
    targetName,
    target,
    provider,
    iac: {
      rootDir: loaded.rootDir,
      config: loaded.config,
      targetName,
      profile: provider.iac,
      ...(dns && { dns }),
      env: ctx.io.env,
      logger: ctx.logger,
      localState,
    },
  };
}

/** The target's deployer, with its infrastructure outputs (cached, or read from state). */
export async function deployerFor(ctx: CommandContext, target: TargetContext): Promise<Deployer> {
  const outputs = await targetOutputs(target.iac);
  return target.provider.createDeployer({
    rootDir: target.loaded.rootDir,
    config: target.loaded.config,
    targetName: target.targetName,
    target: target.target,
    outputs,
    env: ctx.io.env,
    logger: ctx.logger,
    loadConfig: (dir) => loadProjectConfigAt(dir),
  });
}

const SYMBOLS: Record<string, string> = {
  create: '+',
  update: '~',
  delete: '-',
  replace: '-/+',
  read: '<=',
  move: '->',
  noop: ' ',
};

/** Human summary of a plan: one line per resource plus the totals. */
export function formatPlan(plan: PlanSummary): string {
  const lines = plan.resources.map(
    (r) => `  ${SYMBOLS[r.action] ?? '?'} ${r.address} (${r.action})`,
  );
  for (const d of plan.drift)
    lines.push(`  ! ${d.address} changed outside OpenTofu/Terraform (${d.action})`);
  lines.push(
    plan.changes
      ? `Plan: ${plan.add} to add, ${plan.change} to change, ${plan.remove} to destroy.`
      : 'No changes. The infrastructure matches the configuration.',
  );
  return lines.join('\n');
}

/**
 * The confirmation for a change: none with --yes, a prompt when interactive,
 * otherwise SF_CONFIRMATION_REQUIRED (CI never applies by accident).
 */
export function confirmer(ctx: CommandContext, yes: boolean, flag = '--yes'): Confirm | undefined {
  if (yes) return undefined;
  return async (question, plan) => {
    if (!ctx.interactive) {
      throw new SforgeError(
        ErrorCode.ConfirmationRequired,
        `${question.replace(/\?$/, '')}: confirmation required`,
        {
          details: { plan },
          hint: `Pass ${flag} to confirm in non-interactive runs (CI, --json, no TTY).`,
        },
      );
    }
    ctx.io.stderr.write(`${formatPlan(plan)}\n`);
    const answer = await ctx.io.prompt(`${question} Type "yes" to continue: `);
    return answer.trim().toLowerCase() === 'yes';
  };
}

/** Ask a yes/no question without a plan (rollback, preview removal). */
export async function confirmAction(
  ctx: CommandContext,
  yes: boolean,
  question: string,
): Promise<void> {
  if (yes) return;
  if (!ctx.interactive) {
    throw new SforgeError(
      ErrorCode.ConfirmationRequired,
      `${question.replace(/\?$/, '')}: confirmation required`,
      {
        hint: 'Pass --yes to confirm in non-interactive runs (CI, --json, no TTY).',
      },
    );
  }
  const answer = await ctx.io.prompt(`${question} Type "yes" to continue: `);
  if (answer.trim().toLowerCase() !== 'yes') {
    throw new SforgeError(ErrorCode.Aborted, 'Cancelled; nothing was changed');
  }
}

export const truthy = (value: string | undefined): boolean =>
  value !== undefined && value !== '' && value !== 'false' && value !== '0';
