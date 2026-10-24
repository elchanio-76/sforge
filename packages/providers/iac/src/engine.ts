import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { ErrorCode, type Logger, SforgeError } from '@staticforge/core';
import { type Fetch, PINNED_TOFU_VERSION, downloadTofu } from './download.js';

const execFileAsync = promisify(execFile);

export type EngineName = 'tofu' | 'terraform';

/**
 * Oldest supported engine: S3 native state locking (`use_lockfile`) needs
 * OpenTofu 1.10 or Terraform 1.10.
 */
export const MIN_ENGINE_VERSION = '1.10.0';

export interface Engine {
  name: EngineName;
  /** Absolute path of the binary. */
  path: string;
  version: string;
  /** Where the binary came from. */
  source: 'env' | 'path' | 'cache' | 'download';
}

/** Compare dotted versions numerically ("1.10.0" > "1.9.9"); pre-release suffixes are ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .replace(/^v/, '')
      .split(/[-+]/)[0]!
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

function supported(version: string): boolean {
  return compareVersions(version, MIN_ENGINE_VERSION) >= 0 && compareVersions(version, '2.0.0') < 0;
}

/** Directory for sforge's downloads and caches (`~/.cache/staticforge`). */
export function cacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SFORGE_CACHE_DIR) return env.SFORGE_CACHE_DIR;
  return join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'staticforge');
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** First executable named `name` on PATH. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (dir === '') continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

/** The version a binary reports with `version -json` (both engines use `terraform_version`). */
export async function engineVersion(path: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(path, ['version', '-json'], {
      timeout: 30_000,
      env: { ...process.env, CHECKPOINT_DISABLE: '1' },
    });
    const parsed = JSON.parse(stdout) as { terraform_version?: string };
    if (typeof parsed.terraform_version !== 'string') throw new Error('no terraform_version');
    return parsed.terraform_version;
  } catch (error) {
    throw new SforgeError(ErrorCode.EngineMissing, `${path} did not report its version`, {
      cause: error,
    });
  }
}

export interface ResolveEngineOptions {
  engine: EngineName;
  /** Exact version required (`iac.version`). Defaults to any supported version, else the pin. */
  version?: string;
  env?: NodeJS.ProcessEnv;
  logger: Logger;
  fetch?: Fetch;
}

/**
 * Find the OpenTofu or Terraform binary to run:
 * 1. `SFORGE_TOFU_PATH` / `SFORGE_TERRAFORM_PATH`;
 * 2. the binary on PATH, if its version is supported (and equals `version` when set);
 * 3. for OpenTofu only: the cached download, or a fresh, checksum-verified download.
 */
export async function resolveEngine(options: ResolveEngineOptions): Promise<Engine> {
  const env = options.env ?? process.env;
  const { engine, logger } = options;
  const wanted = options.version;
  const accept = (version: string) =>
    wanted !== undefined ? compareVersions(version, wanted) === 0 : supported(version);

  const override = engine === 'tofu' ? env.SFORGE_TOFU_PATH : env.SFORGE_TERRAFORM_PATH;
  if (override) {
    const version = await engineVersion(override);
    if (!supported(version)) {
      throw new SforgeError(
        ErrorCode.EngineMissing,
        `${override} is version ${version}; staticforge needs ${MIN_ENGINE_VERSION} or later (before 2.0)`,
      );
    }
    return { name: engine, path: override, version, source: 'env' };
  }

  const onPath = findOnPath(engine, env);
  if (onPath !== undefined) {
    const version = await engineVersion(onPath);
    if (accept(version)) return { name: engine, path: onPath, version, source: 'path' };
    logger.debug(`Ignoring ${onPath} (version ${version})`);
  }

  if (engine === 'terraform') {
    throw new SforgeError(
      ErrorCode.EngineMissing,
      wanted !== undefined
        ? `Terraform ${wanted} was not found on PATH`
        : `No Terraform ${MIN_ENGINE_VERSION} or later was found on PATH`,
      {
        hint:
          'Install Terraform (https://developer.hashicorp.com/terraform/install), set ' +
          'SFORGE_TERRAFORM_PATH, or use OpenTofu, which sforge downloads itself (iac.engine: "tofu").',
      },
    );
  }

  const version = wanted ?? PINNED_TOFU_VERSION;
  if (!supported(version)) {
    throw new SforgeError(
      ErrorCode.EngineMissing,
      `iac.version ${version} is not supported; use ${MIN_ENGINE_VERSION} or later (before 2.0)`,
    );
  }
  const installDir = join(cacheRoot(env), 'bin', `tofu-${version}`);
  const exe = join(installDir, process.platform === 'win32' ? 'tofu.exe' : 'tofu');
  if (isExecutable(exe)) return { name: 'tofu', path: exe, version, source: 'cache' };
  const path = await downloadTofu({
    version,
    installDir,
    logger,
    ...(options.fetch && { fetch: options.fetch }),
  });
  return { name: 'tofu', path, version, source: 'download' };
}
