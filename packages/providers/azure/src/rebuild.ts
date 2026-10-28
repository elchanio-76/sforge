import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { buildSite } from '@staticforge/build';
import { type LoadedConfig, ErrorCode, SforgeError, targetBaseUrl } from '@staticforge/core';
import type { DeployerContext } from '@staticforge/provider-api';

export interface Rebuilt {
  /** A finished build (with its manifest) of the commit. */
  buildDir: string;
  cleanup(): void;
}

/** Builds the site as it was at a commit. Injectable, so tests need no git history. */
export type Rebuild = (sha: string, context: DeployerContext) => Promise<Rebuilt>;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim();
}

function unavailable(sha: string, reason: string): SforgeError {
  return new SforgeError(ErrorCode.Unsupported, `Cannot rebuild ${sha}: ${reason}`, {
    hint: 'Azure rollbacks rebuild the site from git. Fetch the full history (in CI: fetch-depth: 0) or deploy a fixed version instead.',
  });
}

/**
 * Check the commit out into a temporary worktree next to the real one, build it
 * with that commit's own config and content, and hand over the output. The
 * project's dependencies and image cache are shared, so nothing is installed.
 */
export const rebuildAtCommit: Rebuild = async (sha, context) => {
  const { rootDir } = context;
  // The sha comes from the deploy history in cloud storage: never pass anything else to git,
  // where a leading dash would be read as an option.
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) throw unavailable(sha, 'it is not a commit hash');
  let top: string;
  try {
    top = git(rootDir, ['rev-parse', '--show-toplevel']);
  } catch {
    throw unavailable(sha, 'the project is not in a git repository');
  }
  try {
    git(top, ['cat-file', '-e', `${sha}^{commit}`]);
  } catch {
    throw unavailable(sha, 'the commit is not in this repository');
  }

  const scratch = mkdtempSync(join(tmpdir(), 'sforge-rollback-'));
  const worktree = join(scratch, 'checkout');
  const cleanup = () => {
    try {
      git(top, ['worktree', 'remove', '--force', worktree]);
    } catch {
      // Already gone, or never added.
    }
    rmSync(scratch, { recursive: true, force: true });
    try {
      git(top, ['worktree', 'prune']);
    } catch {
      // Not worth failing a rollback over.
    }
  };

  try {
    git(top, ['worktree', 'add', '--detach', worktree, sha]);
    const projectDir = join(worktree, relative(top, rootDir));

    // Config files may import packages; share the project's node_modules.
    for (const [from, to] of [
      [join(top, 'node_modules'), join(worktree, 'node_modules')],
      [join(rootDir, 'node_modules'), join(projectDir, 'node_modules')],
      [join(rootDir, '.sforge', 'cache'), join(projectDir, '.sforge', 'cache')],
    ] as const) {
      if (existsSync(from) && !existsSync(to)) {
        mkdirSync(join(to, '..'), { recursive: true });
        symlinkSync(from, to, 'dir');
      }
    }

    if (context.loadConfig === undefined) {
      throw new SforgeError(ErrorCode.Internal, 'The provider was created without a config loader');
    }
    let loaded: LoadedConfig;
    try {
      loaded = await context.loadConfig(projectDir);
    } catch (error) {
      throw unavailable(sha, `its configuration cannot be loaded (${(error as Error).message})`);
    }
    context.logger.info(`Building ${sha} for the rollback`);
    const build = await buildSite({
      rootDir: loaded.rootDir,
      config: loaded.config,
      baseUrl: targetBaseUrl(loaded.config, context.targetName),
      scratchDir: join(scratch, 'out'),
      logger: context.logger,
    });
    if (!build.ok) {
      throw new SforgeError(ErrorCode.DeployFailed, `Version ${sha} no longer builds`, {
        details: { diagnostics: build.diagnostics.filter((d) => d.severity === 'error') },
      });
    }
    return { buildDir: build.outDir, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
};
