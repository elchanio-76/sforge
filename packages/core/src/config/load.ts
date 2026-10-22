import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { createJiti } from 'jiti';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import { ErrorCode, SforgeError } from '../errors.js';
import { configSchema, type SforgeConfig, type TargetConfig } from './schema.js';

/** Config file names, in lookup priority order. */
export const CONFIG_FILE_NAMES = [
  'staticforge.config.ts',
  'staticforge.config.mts',
  'staticforge.config.js',
  'staticforge.config.mjs',
  'staticforge.config.json',
  'staticforge.config.yaml',
  'staticforge.config.yml',
] as const;

export interface LoadedConfig {
  config: SforgeConfig;
  /** Absolute path of the config file. */
  path: string;
  /** Project root: the directory containing the config file. */
  rootDir: string;
}

export interface ConfigIssue {
  /** Dotted path to the offending key, e.g. "targets.prod.region". */
  path: string;
  message: string;
}

/**
 * Locate the config file: an explicit path if given, otherwise search `cwd`
 * and its ancestors.
 */
export function findConfigFile(cwd: string, explicitPath?: string): string {
  if (explicitPath !== undefined) {
    const path = isAbsolute(explicitPath) ? explicitPath : resolve(cwd, explicitPath);
    if (!existsSync(path)) {
      throw new SforgeError(ErrorCode.ConfigNotFound, `Config file not found: ${path}`);
    }
    return path;
  }

  let dir = resolve(cwd);
  for (;;) {
    for (const name of CONFIG_FILE_NAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new SforgeError(
    ErrorCode.ConfigNotFound,
    `No staticforge config found in ${resolve(cwd)} or any parent directory`,
    { hint: 'Run `sforge init` to create a project, or pass --config <path>.' },
  );
}

async function readRawConfig(path: string): Promise<unknown> {
  const ext = extname(path);
  try {
    if (ext === '.json') return JSON.parse(readFileSync(path, 'utf8'));
    if (ext === '.yaml' || ext === '.yml') return parseYaml(readFileSync(path, 'utf8'));
    const jiti = createJiti(import.meta.url, { moduleCache: false });
    return await jiti.import(path, { default: true });
  } catch (error) {
    throw new SforgeError(
      ErrorCode.ConfigLoadFailed,
      `Failed to load ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function toIssues(error: z.ZodError): ConfigIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.') || '(root)',
    message: issue.message,
  }));
}

/** Validate a raw config object, returning the resolved config with defaults applied. */
export function validateConfig(raw: unknown, source = 'config'): SforgeConfig {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const issues = toIssues(result.error);
    throw new SforgeError(
      ErrorCode.ConfigInvalid,
      `Invalid ${source}:\n${issues.map((i) => `  - ${i.path}: ${i.message}`).join('\n')}`,
      { details: { issues } },
    );
  }
  return result.data;
}

export interface LoadConfigOptions {
  cwd?: string;
  /** Explicit config path (from `--config`). */
  configPath?: string;
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const path = findConfigFile(options.cwd ?? process.cwd(), options.configPath);
  const raw = await readRawConfig(path);
  return { config: validateConfig(raw, path), path, rootDir: dirname(path) };
}

export function getTarget(config: SforgeConfig, name: string): TargetConfig {
  const target = config.targets[name];
  if (target === undefined) {
    const known = Object.keys(config.targets);
    throw new SforgeError(ErrorCode.TargetNotFound, `Unknown target "${name}"`, {
      details: { target: name, known },
      hint: known.length > 0 ? `Known targets: ${known.join(', ')}` : 'No targets are configured.',
    });
  }
  return target;
}
