import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ErrorCode, type Logger, SforgeError, getTarget } from '@staticforge/core';
import type { SforgeConfig } from '@staticforge/core';
import { type Engine, type EngineName, resolveEngine } from './engine.js';
import {
  type ApplySummary,
  type PlanSummary,
  type Workspace,
  apply,
  hasLocalState,
  init,
  outputs,
  plan,
  publicOutputs,
  refreshState,
} from './operations.js';
import { type RunResult, runEngine } from './runner.js';
import type { DnsProfile, IacProfile, IacSpec, PreparedTarget, StateBackend } from './spec.js';
import { extraHclDir, workspaceDir, writeWorkspace } from './workspace.js';

/** `.sforge/state/<target>.json`: the non-secret outputs of the last apply. */
export function stateCachePath(rootDir: string, targetName: string): string {
  return join(rootDir, '.sforge', 'state', `${targetName}.json`);
}

export interface CachedOutputs {
  target: string;
  provider: string;
  engine: EngineName;
  updatedAt: string;
  outputs: Record<string, unknown>;
}

export function readCachedOutputs(rootDir: string, targetName: string): CachedOutputs | undefined {
  const path = stateCachePath(rootDir, targetName);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CachedOutputs;
  } catch {
    return undefined;
  }
}

function writeCachedOutputs(rootDir: string, cache: CachedOutputs): void {
  const path = stateCachePath(rootDir, cache.target);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(cache, null, 2)}\n`);
  renameSync(temp, path);
}

/** Asked before applying; resolves false to abort. */
export type Confirm = (question: string, plan: PlanSummary) => Promise<boolean>;

export interface IacRunOptions {
  rootDir: string;
  config: SforgeConfig;
  targetName: string;
  profile: IacProfile;
  /** The DNS provider of the target's `dns`, when it is set. */
  dns?: DnsProfile;
  env?: NodeJS.ProcessEnv;
  logger: Logger;
  /** Keep state in the workspace instead of the remote backend. */
  localState?: boolean;
  /** Extra module inputs for this run. */
  inputs?: Record<string, unknown>;
  /** Engine to use instead of resolving one (tests). */
  engine?: Engine;
  purpose?: 'provision' | 'outputs';
}

interface Opened {
  engine: Engine;
  prepared: PreparedTarget;
  ws: Workspace;
}

/** Resolve the engine and prepare the target's spec. */
async function open(options: IacRunOptions): Promise<Opened> {
  const env = options.env ?? process.env;
  const target = getTarget(options.config, options.targetName);
  if (target.provider !== options.profile.provider) {
    throw new SforgeError(
      ErrorCode.Internal,
      `Profile ${options.profile.provider} used for ${target.provider}`,
    );
  }
  const engine =
    options.engine ??
    (await resolveEngine({
      engine: options.config.iac.engine,
      ...(options.config.iac.version !== undefined && { version: options.config.iac.version }),
      env,
      logger: options.logger,
    }));
  options.logger.debug(`Using ${engine.name} ${engine.version} (${engine.path})`);
  const prepared = await options.profile.prepare({
    rootDir: options.rootDir,
    config: options.config,
    targetName: options.targetName,
    target,
    env,
    logger: options.logger,
    ...(options.inputs && { inputs: options.inputs }),
    ...(options.purpose && { purpose: options.purpose }),
    ...(options.dns && { dns: options.dns }),
  });
  if (options.localState)
    prepared.spec = { ...prepared.spec, backend: { type: 'local', config: {} } };
  const ws: Workspace = {
    engine,
    dir: workspaceDir(options.rootDir, options.targetName),
    env: { ...env, ...prepared.spec.env },
    logger: options.logger,
  };
  return { engine, prepared, ws };
}

function write(options: IacRunOptions, ws: Workspace, spec: IacSpec): void {
  writeWorkspace({
    dir: ws.dir,
    spec,
    vendor: options.config.iac.vendor,
    extraDir: extraHclDir(options.rootDir, options.targetName),
  });
}

function withoutExpectedDrift(planned: PlanSummary, prepared: PreparedTarget): PlanSummary {
  const expected = new Set(prepared.expectedDrift ?? []);
  return { ...planned, drift: planned.drift.filter((d) => !expected.has(d.address)) };
}

function requireState(state: StateBackend, targetName: string): void {
  if (state.exists) return;
  throw new SforgeError(
    ErrorCode.StateMissing,
    `The state backend for "${targetName}" (${state.description}) does not exist yet`,
    {
      details: { backend: state.id },
      hint: `Create it with \`sforge provision ${targetName} --bootstrap-state\` (or use --local-state for an experiment).`,
    },
  );
}

export interface BootstrapResult {
  backend: string;
  description: string;
  created: boolean;
}

/**
 * Create the remote state backend: apply the bootstrap module with local
 * state, then migrate that state into the backend it created. An existing
 * backend is left alone, so bootstrapping is safe to repeat.
 */
export async function bootstrapState(
  options: Omit<IacRunOptions, 'profile' | 'localState'> & {
    engine: Engine;
    state: StateBackend;
    confirm?: Confirm;
  },
): Promise<BootstrapResult> {
  const { state, logger } = options;
  const ws: Workspace = {
    engine: options.engine,
    dir: workspaceDir(options.rootDir, join('_state', state.id)),
    env: { ...(options.env ?? process.env), ...state.bootstrap.env },
    logger,
  };
  const result = { backend: state.id, description: state.description };
  // A previous run may have created the storage but failed to migrate its state.
  const pending = hasLocalState(ws.dir);
  if (state.exists && !pending) {
    logger.info(`State backend ${state.description} already exists`);
    return { ...result, created: false };
  }

  if (!pending) {
    logger.info(`Creating state backend ${state.description}`);
    writeWorkspace({
      dir: ws.dir,
      spec: { ...state.bootstrap, backend: { type: 'local', config: {} } },
    });
    await init(ws);
    const planned = await plan(ws);
    if (planned.planFile !== undefined) {
      if (
        options.confirm &&
        !(await options.confirm(`Create the state backend ${state.description}?`, planned))
      ) {
        throw new SforgeError(ErrorCode.Aborted, 'Bootstrap cancelled');
      }
      await apply(ws, planned.planFile);
    }
  }

  logger.info(`Moving the bootstrap state into ${state.description}`);
  writeWorkspace({ dir: ws.dir, spec: state.bootstrap });
  await init(ws, { migrateState: true });
  for (const file of ['terraform.tfstate', 'terraform.tfstate.backup', 'tfplan']) {
    rmSync(join(ws.dir, file), { force: true });
  }
  return { ...result, created: true };
}

export interface ProvisionResult {
  target: string;
  provider: string;
  engine: { name: EngineName; version: string };
  workspace: string;
  bootstrap?: BootstrapResult;
  plan: PlanSummary;
  /** False for --diff, when nothing changed, or when declined. */
  applied: boolean;
  apply?: ApplySummary;
  outputs?: Record<string, unknown>;
  /** Instructions for the user, e.g. DNS records to create. */
  notices: string[];
  /** True when provisioning stopped after the pre-phase (`noWait`). */
  pending?: boolean;
}

export interface ProvisionOptions extends IacRunOptions {
  /** Only plan (`provision --diff`). */
  diff?: boolean;
  /** Create the remote state backend first. */
  bootstrapState?: boolean;
  /** Asked before applying; omit to apply without asking (--yes). */
  confirm?: Confirm;
  /** Stop after the pre-phase instead of waiting for it (e.g. for DNS validation). */
  noWait?: boolean;
}

/** `sforge provision`: plan, and unless `diff`, apply after confirmation. */
export async function provision(options: ProvisionOptions): Promise<ProvisionResult> {
  const { engine, prepared, ws } = await open(options);
  const { spec, state } = prepared;
  const result = {
    target: options.targetName,
    provider: options.profile.provider,
    engine: { name: engine.name, version: engine.version },
    workspace: ws.dir,
  };

  let bootstrap: BootstrapResult | undefined;
  if (!options.localState) {
    if (options.bootstrapState && !options.diff) {
      bootstrap = await bootstrapState({
        ...options,
        engine,
        state,
        ...(options.confirm && { confirm: options.confirm }),
      });
    } else {
      requireState(state, options.targetName);
    }
  }

  write(options, ws, spec);
  await init(ws);
  const notices: string[] = [];
  if (prepared.prePhase !== undefined && !options.diff) {
    const first = await plan(ws, { targets: prepared.prePhase.targets });
    if (first.planFile !== undefined) {
      if (
        options.confirm &&
        !(await options.confirm(`Create ${prepared.prePhase.targets.join(', ')} first?`, first))
      ) {
        throw new SforgeError(ErrorCode.Aborted, 'Provisioning cancelled; nothing was changed');
      }
      await apply(ws, first.planFile);
    }
    const values = publicOutputs(await outputs(ws));
    const notice = prepared.prePhase.describe(values);
    if (notice !== undefined) {
      notices.push(notice);
      options.logger.info(notice);
    }
    if (options.noWait) {
      rmSync(join(ws.dir, 'tfplan'), { force: true });
      return {
        ...result,
        ...(bootstrap && { bootstrap }),
        plan: first,
        applied: first.planFile !== undefined,
        notices,
        pending: true,
      };
    }
    await prepared.prePhase.wait?.(values, options.logger);
  }
  const planned = withoutExpectedDrift(await plan(ws), prepared);
  const base = { ...result, ...(bootstrap && { bootstrap }), plan: planned, notices };
  if (options.diff || planned.planFile === undefined) {
    if (!options.diff) {
      const values = publicOutputs(await outputs(ws));
      cache(options, engine, values);
      return { ...base, applied: false, outputs: values };
    }
    return { ...base, applied: false };
  }
  if (
    options.confirm &&
    !(await options.confirm(`Apply these changes to "${options.targetName}"?`, planned))
  ) {
    throw new SforgeError(ErrorCode.Aborted, 'Provisioning cancelled; nothing was changed');
  }
  const applied = await apply(ws, planned.planFile);
  rmSync(join(ws.dir, planned.planFile), { force: true });
  await refreshState(ws);
  const values = publicOutputs(await outputs(ws));
  cache(options, engine, values);
  return { ...base, applied: true, apply: applied, outputs: values };
}

function cache(options: IacRunOptions, engine: Engine, values: Record<string, unknown>): void {
  writeCachedOutputs(options.rootDir, {
    target: options.targetName,
    provider: options.profile.provider,
    engine: engine.name,
    updatedAt: new Date().toISOString(),
    outputs: values,
  });
}

/**
 * The target's non-secret outputs: from `.sforge/state/<target>.json`, or
 * (e.g. in CI, where that cache is not committed) read from the state.
 */
export async function targetOutputs(options: IacRunOptions): Promise<Record<string, unknown>> {
  const cached = readCachedOutputs(options.rootDir, options.targetName);
  if (cached !== undefined) return cached.outputs;
  const { engine, prepared, ws } = await open({ ...options, purpose: 'outputs' });
  if (!options.localState) requireState(prepared.state, options.targetName);
  write(options, ws, prepared.spec);
  await init(ws);
  const values = publicOutputs(await outputs(ws));
  if (Object.keys(values).length === 0) {
    throw new SforgeError(
      ErrorCode.NotProvisioned,
      `Target "${options.targetName}" has not been provisioned`,
      { hint: `Run \`sforge provision ${options.targetName}\` first.` },
    );
  }
  cache(options, engine, values);
  return values;
}

export interface DriftResult {
  target: string;
  provider: string;
  engine: { name: EngineName; version: string };
  /** Resources changed outside OpenTofu/Terraform since the last apply. */
  drift: PlanSummary['drift'];
  drifted: boolean;
  outputs: Record<string, unknown>;
}

/** `sforge status`: a refresh-only plan, reporting drift and the current outputs. */
export async function detectDrift(options: IacRunOptions): Promise<DriftResult> {
  const { engine, prepared, ws } = await open(options);
  if (!options.localState) requireState(prepared.state, options.targetName);
  write(options, ws, prepared.spec);
  await init(ws);
  const planned = await plan(ws, { refreshOnly: true });
  rmSync(join(ws.dir, 'tfplan'), { force: true });
  const expected = new Set(prepared.expectedDrift ?? []);
  const drift = planned.drift.filter((d) => !expected.has(d.address));
  const values = publicOutputs(await outputs(ws));
  return {
    target: options.targetName,
    provider: options.profile.provider,
    engine: { name: engine.name, version: engine.version },
    drift,
    // A refresh-only plan has changes exactly when something drifted.
    drifted: drift.length > 0,
    outputs: values,
  };
}

export interface DestroyResult {
  target: string;
  provider: string;
  plan: PlanSummary;
  destroyed: boolean;
}

/** `sforge destroy`: remove every resource of the target (the state backend stays). */
export async function destroy(
  options: IacRunOptions & { confirm?: Confirm },
): Promise<DestroyResult> {
  const { prepared, ws } = await open(options);
  if (!options.localState) requireState(prepared.state, options.targetName);
  const base = { target: options.targetName, provider: options.profile.provider };

  write(options, ws, prepared.spec);
  await init(ws);
  const planned = await plan(ws, { destroy: true });
  if (planned.planFile === undefined) return { ...base, plan: planned, destroyed: false };
  if (
    options.confirm &&
    !(await options.confirm(`Destroy every resource of "${options.targetName}"?`, planned))
  ) {
    throw new SforgeError(ErrorCode.Aborted, 'Destroy cancelled; nothing was changed');
  }
  if (prepared.preDestroyInputs !== undefined) {
    // E.g. allow non-empty buckets to be deleted: this must be in state before destroying.
    write(options, ws, {
      ...prepared.spec,
      module: {
        ...prepared.spec.module,
        inputs: { ...prepared.spec.module.inputs, ...prepared.preDestroyInputs },
      },
    });
    const unlock = await plan(ws);
    if (unlock.planFile !== undefined) await apply(ws, unlock.planFile);
    const replanned = await plan(ws, { destroy: true });
    if (replanned.planFile !== undefined) await apply(ws, replanned.planFile);
  } else {
    await apply(ws, planned.planFile);
  }
  rmSync(join(ws.dir, 'tfplan'), { force: true });
  rmSync(stateCachePath(options.rootDir, options.targetName), { force: true });
  return { ...base, plan: planned, destroyed: true };
}

export type PassthroughCommand =
  'init' | 'plan' | 'apply' | 'output' | 'validate' | 'state' | 'import' | 'show' | 'console';

/** Generate the workspace and return it, for `sforge iac path` and the passthrough commands. */
export async function prepareWorkspace(options: IacRunOptions): Promise<Opened> {
  const opened = await open(options);
  write(options, opened.ws, opened.prepared.spec);
  return opened;
}

/** `sforge iac <command> <target> [-- args]`: run the engine directly in the workspace. */
export async function passthrough(
  options: IacRunOptions & {
    command: PassthroughCommand;
    args: string[];
    onStdout: (chunk: string) => void;
    onStderr: (chunk: string) => void;
    interactive: boolean;
  },
): Promise<RunResult & { workspace: string }> {
  const { prepared, ws } = await prepareWorkspace(options);
  if (!options.localState && options.command !== 'init')
    requireState(prepared.state, options.targetName);
  if (options.command !== 'init' && !existsSync(join(ws.dir, '.terraform'))) await init(ws);
  const result = await runEngine(ws.engine, [options.command, ...options.args], {
    cwd: ws.dir,
    env: ws.env,
    onStdout: options.onStdout,
    onStderr: options.onStderr,
    interactive: options.interactive,
  });
  return { ...result, workspace: ws.dir };
}
