import { existsSync, readFileSync, statSync } from 'node:fs';
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

const CONFIG_EXTENSIONS = new Set(['.ts', '.mts', '.js', '.mjs', '.json', '.yaml', '.yml']);

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

function findInDirectory(dir: string): string | undefined {
  for (const name of CONFIG_FILE_NAMES) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Locate the config file. An explicit path may name the file or the project
 * directory containing it. Otherwise search `cwd` and its ancestors.
 */
export function findConfigFile(cwd: string, explicitPath?: string): string {
  if (explicitPath !== undefined) {
    const path = isAbsolute(explicitPath) ? explicitPath : resolve(cwd, explicitPath);
    if (!existsSync(path)) {
      throw new SforgeError(ErrorCode.ConfigNotFound, `Config file not found: ${path}`);
    }
    if (statSync(path).isDirectory()) {
      const found = findInDirectory(path);
      if (found === undefined) {
        throw new SforgeError(ErrorCode.ConfigNotFound, `No staticforge config found in ${path}`, {
          hint: `Expected one of: ${CONFIG_FILE_NAMES.join(', ')}`,
        });
      }
      return found;
    }
    if (!CONFIG_EXTENSIONS.has(extname(path))) {
      throw new SforgeError(ErrorCode.ConfigLoadFailed, `Unsupported config file type: ${path}`, {
        hint: `Use one of: ${[...CONFIG_EXTENSIONS].join(', ')}`,
      });
    }
    return path;
  }

  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const found = findInDirectory(dir);
    if (found !== undefined) return found;
    if (dirname(dir) === dir) break;
  }

  throw new SforgeError(
    ErrorCode.ConfigNotFound,
    `No staticforge config found in ${resolve(cwd)} or any parent directory`,
    { hint: 'Run `sforge init` to create a project, or pass --config <path>.' },
  );
}

class MissingDefaultExport extends Error {}

async function readRawConfig(path: string, aliases: Record<string, string>): Promise<unknown> {
  const ext = extname(path);
  try {
    if (ext === '.json') return JSON.parse(readFileSync(path, 'utf8'));
    if (ext === '.yaml' || ext === '.yml') return parseYaml(readFileSync(path, 'utf8'));
    const jiti = createJiti(import.meta.url, { moduleCache: false, alias: aliases });
    const module = await jiti.import<Record<string, unknown>>(path);
    if (!('default' in module)) throw new MissingDefaultExport();
    return module.default;
  } catch (error) {
    if (error instanceof MissingDefaultExport) {
      throw new SforgeError(ErrorCode.ConfigLoadFailed, `${path} has no default export`, {
        hint: 'Export the config with `export default defineConfig({ ... })`.',
      });
    }
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
  /** Explicit config file or project directory (from `--config`). */
  configPath?: string;
  /**
   * Module specifiers to resolve to fixed paths when evaluating JS/TS configs.
   * The CLI maps `staticforge` to itself so configs work without installing it.
   */
  aliases?: Record<string, string>;
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const path = findConfigFile(options.cwd ?? process.cwd(), options.configPath);
  const raw = await readRawConfig(path, options.aliases ?? {});
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

/**
 * The URL a target serves production at, for canonical links, feeds and
 * sitemaps: `targets.<n>.baseUrl`, else `https://<domain>/`, else
 * `site.baseUrl`. Unknown targets get `site.baseUrl` (e.g. an older commit's
 * config that predates the target).
 */
export function targetBaseUrl(config: SforgeConfig, name: string): string {
  const target = config.targets[name];
  if (target?.baseUrl !== undefined) return target.baseUrl;
  if (target?.domain !== undefined) return `https://${target.domain}/`;
  return config.site.baseUrl;
}
