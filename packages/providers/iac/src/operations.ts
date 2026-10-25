import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ErrorCode, type Logger, SforgeError } from '@staticforge/core';
import type { Engine } from './engine.js';
import { type EngineEvent, type RunResult, assertSucceeded, runEngine } from './runner.js';

/** A workspace and the engine that runs it. */
export interface Workspace {
  engine: Engine;
  dir: string;
  env: NodeJS.ProcessEnv;
  logger: Logger;
}

export type ChangeAction = 'create' | 'update' | 'delete' | 'replace' | 'read' | 'noop' | 'move';

export interface ResourceChange {
  address: string;
  action: ChangeAction;
}

export interface PlanSummary {
  /** True when applying the plan would change something. */
  changes: boolean;
  add: number;
  change: number;
  remove: number;
  import: number;
  resources: ResourceChange[];
  /** Changes made outside OpenTofu/Terraform, detected while refreshing. */
  drift: ResourceChange[];
  /** Saved plan file (absent for refresh-only and failed plans). */
  planFile?: string;
}

export interface ApplySummary {
  add: number;
  change: number;
  remove: number;
}

export interface OutputValue {
  value: unknown;
  sensitive: boolean;
  type?: unknown;
}

/** Platforms recorded in `.terraform.lock.hcl`, so a lock made on a laptop also works in CI. */
export const LOCK_PLATFORMS = [
  'linux_amd64',
  'linux_arm64',
  'darwin_amd64',
  'darwin_arm64',
  'windows_amd64',
];

/** Log engine progress: resource operations at info, the rest at debug. */
function progressLogger(logger: Logger) {
  return (event: EngineEvent) => {
    if (event.message === '') return;
    switch (event.type) {
      case 'apply_start':
      case 'apply_complete':
      case 'apply_errored':
      case 'resource_drift':
        logger.info(event.message);
        break;
      case 'diagnostic':
        if (event.level === 'warn') logger.warn(event.message);
        else logger.debug(event.message);
        break;
      default:
        logger.debug(event.message);
    }
  };
}

function run(ws: Workspace, args: string[], json = true): Promise<RunResult> {
  ws.logger.debug(`${ws.engine.name} ${args.join(' ')}`);
  return runEngine(ws.engine, args, {
    cwd: ws.dir,
    env: ws.env,
    json,
    onEvent: progressLogger(ws.logger),
  });
}

export interface InitOptions {
  /** `-migrate-state -force-copy`: move existing state into the configured backend. */
  migrateState?: boolean;
  /** `-reconfigure`: use the configured backend, ignoring the previous one. */
  reconfigure?: boolean;
  /** `-backend=false`: install modules and providers only (for validate). */
  noBackend?: boolean;
}

/**
 * Whether `.terraform.lock.hcl` lacks a provider that `main.tf.json` requires
 * (e.g. a DNS provider added to a provisioned target): init would lock it for
 * the current platform only. A missing lock file counts as lacking all.
 */
function lockIncomplete(dir: string): boolean {
  const lockFile = join(dir, '.terraform.lock.hcl');
  if (!existsSync(lockFile)) return true;
  let required: Record<string, { source?: string }> = {};
  try {
    const main = JSON.parse(readFileSync(join(dir, 'main.tf.json'), 'utf8')) as {
      terraform?: { required_providers?: typeof required };
    };
    required = main.terraform?.required_providers ?? {};
  } catch {
    return false;
  }
  const lock = readFileSync(lockFile, 'utf8').toLowerCase();
  return Object.values(required).some(
    (p) => p.source !== undefined && !lock.includes(`/${p.source.toLowerCase()}"`),
  );
}

/**
 * `init`. When the lock file is new or lacks a required provider, init also
 * records provider checksums for the common platforms in `.terraform.lock.hcl`.
 */
export async function init(ws: Workspace, options: InitOptions = {}): Promise<void> {
  const lockFile = join(ws.dir, '.terraform.lock.hcl');
  const needsPlatforms = lockIncomplete(ws.dir);
  const args = ['init', '-input=false', '-no-color'];
  if (options.migrateState) args.push('-migrate-state', '-force-copy');
  if (options.reconfigure) args.push('-reconfigure');
  if (options.noBackend) args.push('-backend=false');
  const result = await run(ws, args, false);
  if (
    result.exitCode !== 0 &&
    /backend configuration (has )?changed/i.test(result.stdout + result.stderr)
  ) {
    throw new SforgeError(ErrorCode.IacFailed, 'The state backend configuration changed', {
      details: { diagnostics: result.diagnostics },
      hint:
        'Move the state with `sforge iac init <target> -- -migrate-state`, ' +
        'or start over in the new backend with `-- -reconfigure`.',
    });
  }
  assertSucceeded(result, `${ws.engine.name} init`);
  if (needsPlatforms && existsSync(lockFile)) {
    const lock = await run(
      ws,
      ['providers', 'lock', ...LOCK_PLATFORMS.map((p) => `-platform=${p}`)],
      false,
    );
    // Not fatal: the lock still covers the current platform.
    if (lock.exitCode !== 0) ws.logger.warn('Could not add other platforms to .terraform.lock.hcl');
  }
}

function change(raw: Record<string, unknown>): ResourceChange | undefined {
  const c = raw.change as { resource?: { addr?: string }; action?: string } | undefined;
  if (c?.resource?.addr === undefined || c.action === undefined) return undefined;
  return { address: c.resource.addr, action: c.action as ChangeAction };
}

function summarize(result: RunResult): Omit<PlanSummary, 'changes' | 'planFile'> {
  const resources: ResourceChange[] = [];
  const drift: ResourceChange[] = [];
  let counts = { add: 0, change: 0, remove: 0, import: 0 };
  for (const event of result.events) {
    if (event.type === 'planned_change') {
      const c = change(event.raw);
      if (c !== undefined) resources.push(c);
    } else if (event.type === 'resource_drift') {
      const c = change(event.raw);
      if (c !== undefined) drift.push(c);
    } else if (event.type === 'change_summary') {
      const c = event.raw.changes as Partial<typeof counts> | undefined;
      counts = {
        add: c?.add ?? 0,
        change: c?.change ?? 0,
        remove: c?.remove ?? 0,
        import: c?.import ?? 0,
      };
    }
  }
  return { ...counts, resources, drift };
}

export interface PlanOptions {
  /** Only compare the state with the real infrastructure (drift detection). */
  refreshOnly?: boolean;
  destroy?: boolean;
  /** Plan file to write (relative to the workspace). Defaults to `tfplan`. */
  out?: string;
  /** Only these resource addresses (`-target`). */
  targets?: string[];
}

/** `plan -detailed-exitcode`: 0 no changes, 2 changes, anything else failed. */
export async function plan(ws: Workspace, options: PlanOptions = {}): Promise<PlanSummary> {
  const out = options.out ?? 'tfplan';
  const args = ['plan', '-input=false', '-json', '-detailed-exitcode', `-out=${out}`];
  if (options.refreshOnly) args.push('-refresh-only');
  if (options.destroy) args.push('-destroy');
  for (const target of options.targets ?? []) args.push(`-target=${target}`);
  const result = await run(ws, args);
  assertSucceeded(result, `${ws.engine.name} plan`, [0, 2]);
  const summary = summarize(result);
  return {
    ...summary,
    changes: result.exitCode === 2,
    ...(result.exitCode === 2 && { planFile: out }),
  };
}

/** Apply a saved plan. */
export async function apply(ws: Workspace, planFile: string): Promise<ApplySummary> {
  const result = await run(ws, ['apply', '-input=false', '-json', planFile]);
  assertSucceeded(result, `${ws.engine.name} apply`);
  const summary = summarize(result);
  return { add: summary.add, change: summary.change, remove: summary.remove };
}

/**
 * `apply -refresh-only`: record attributes the provider only reports after
 * creation (a function's status, a bucket's policy, empty lists). Run right
 * after an apply, so `sforge status` reports only real drift.
 */
export async function refreshState(ws: Workspace): Promise<void> {
  const result = await run(ws, [
    'apply',
    '-refresh-only',
    '-auto-approve',
    '-input=false',
    '-json',
  ]);
  assertSucceeded(result, `${ws.engine.name} apply -refresh-only`);
}

/** `output -json`: every root output, sensitive ones included (callers must filter). */
export async function outputs(ws: Workspace): Promise<Record<string, OutputValue>> {
  const result = await run(ws, ['output', '-json', '-no-color'], false);
  assertSucceeded(result, `${ws.engine.name} output`);
  const text = result.stdout.trim();
  if (text === '') return {};
  try {
    return JSON.parse(text) as Record<string, OutputValue>;
  } catch (error) {
    throw new SforgeError(ErrorCode.IacFailed, `Could not parse ${ws.engine.name} output -json`, {
      cause: error,
    });
  }
}

/** Non-sensitive output values, keyed by name. */
export function publicOutputs(values: Record<string, OutputValue>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values)
      .filter(([, output]) => !output.sensitive)
      .map(([name, output]) => [name, output.value]),
  );
}

/** Whether a workspace holds local state (only with --local-state or a pending bootstrap). */
export function hasLocalState(dir: string): boolean {
  const path = join(dir, 'terraform.tfstate');
  if (!existsSync(path)) return false;
  try {
    const state = JSON.parse(readFileSync(path, 'utf8')) as { resources?: unknown[] };
    return (state.resources?.length ?? 0) > 0;
  } catch {
    return true;
  }
}
