import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { Option, type Command } from 'commander';
import { ErrorCode, SforgeError, type SforgeConfig, getTarget } from '@staticforge/core';
import { readCachedOutputs } from '@staticforge/iac';
import { type CiTarget, type RepoVariable, variablesFor, workflows } from '../ci/workflows.js';
import { type Runtime, action } from '../command.js';
import { loadProjectConfig } from '../project.js';

const toPosix = (path: string) => path.split(sep).join('/');

/** The repository root, or the project itself outside git. */
function gitRoot(dir: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

function packageManager(rootDir: string, repoDir: string): 'pnpm' | 'npm' {
  for (const dir of [rootDir, repoDir]) {
    if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
    if (existsSync(join(dir, 'package-lock.json'))) return 'npm';
  }
  return 'npm';
}

/** pnpm/action-setup needs a version unless package.json names one in `packageManager`. */
function pnpmVersion(rootDir: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')) as {
      packageManager?: string;
    };
    if (pkg.packageManager?.startsWith('pnpm@')) return undefined;
  } catch {
    // No package.json: fall through.
  }
  try {
    const version = execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim();
    return version.split('.')[0] ?? 'latest';
  } catch {
    return 'latest';
  }
}

function nodeVersionFile(rootDir: string, repoDir: string): string | undefined {
  for (const dir of [rootDir, repoDir]) {
    for (const name of ['.nvmrc', '.node-version']) {
      if (existsSync(join(dir, name))) return toPosix(relative(repoDir, join(dir, name)));
    }
  }
  return undefined;
}

/** The targets to deploy from CI: the named ones, or every target with `ci`. */
function ciTargets(config: SforgeConfig, names: string[] | undefined): CiTarget[] {
  const chosen = names ?? Object.keys(config.targets).filter((n) => config.targets[n]?.ci);
  if (chosen.length === 0) {
    throw new SforgeError(ErrorCode.ConfigInvalid, 'No target has a GitHub Actions identity', {
      hint: 'Add ci: { repo: "owner/repo" } to a target and run `sforge provision <target>`.',
    });
  }
  return chosen.map((name) => {
    const target = getTarget(config, name);
    if (target.ci === undefined) {
      throw new SforgeError(ErrorCode.ConfigInvalid, `targets.${name} has no ci`, {
        hint: 'CI deploys sign in with the identity `provision` creates for ci: { repo }.',
      });
    }
    const environment = target.ci.environments[0];
    // AWS previews are served from *.<previewDomain>; Azure ones from named environments.
    const previews =
      target.ci.pullRequests &&
      (target.provider === 'azure' ||
        (target.domain !== undefined && target.previewDomain !== undefined));
    return {
      name,
      provider: target.provider,
      ...(target.provider === 'aws' && { region: target.region }),
      ...(environment !== undefined && { environment }),
      branch: target.ci.branches[0] ?? 'main',
      previews,
    };
  });
}

interface VariableStatus extends RepoVariable {
  /** The provisioned value; null until the target is provisioned. */
  value: string | null;
}

export function registerCiCommand(program: Command, runtime: Runtime): void {
  const ci = program.command('ci').description('GitHub Actions workflows');

  ci.command('init')
    .description('Write GitHub Actions workflows that check, preview and deploy the targets')
    .option('--targets <names>', 'comma-separated targets (default: every target with ci)')
    .addOption(
      new Option('--package-manager <name>', 'default: from the lockfile').choices(['pnpm', 'npm']),
    )
    .option('--force', 'overwrite existing workflow files')
    .action(
      action(runtime, async (ctx, { options }) => {
        const { config, rootDir } = await loadProjectConfig(ctx);
        const names = (options.targets as string | undefined)
          ?.split(',')
          .map((n) => n.trim())
          .filter((n) => n !== '');
        const targets = ciTargets(config, names);
        const repoDir = gitRoot(rootDir) ?? rootDir;
        const pm =
          (options.packageManager as 'pnpm' | 'npm' | undefined) ??
          packageManager(rootDir, repoDir);
        const pnpm = pm === 'pnpm' ? pnpmVersion(rootDir) : undefined;
        const nvmrc = nodeVersionFile(rootDir, repoDir);
        const { PLAYWRIGHT_VERSION } = await import('@staticforge/checker');

        const files = workflows({
          targets,
          packageManager: pm,
          workingDirectory: toPosix(relative(repoDir, rootDir)),
          ...(nvmrc !== undefined && { nodeVersionFile: nvmrc }),
          ...(pnpm !== undefined && { pnpmVersion: pnpm }),
          playwrightVersion: PLAYWRIGHT_VERSION,
        });
        const dir = join(repoDir, '.github', 'workflows');
        mkdirSync(dir, { recursive: true });
        const created: string[] = [];
        const skipped: string[] = [];
        for (const [name, content] of Object.entries(files)) {
          const path = join(dir, name);
          const shown = toPosix(relative(repoDir, path));
          if (existsSync(path) && options.force !== true) {
            skipped.push(shown);
            continue;
          }
          writeFileSync(path, content);
          created.push(shown);
        }

        const variables: VariableStatus[] = targets.flatMap((t) => {
          const outputs = readCachedOutputs(rootDir, t.name)?.outputs ?? {};
          return variablesFor(t).map((v) => {
            const value = outputs[v.output];
            return { ...v, value: typeof value === 'string' && value !== '' ? value : null };
          });
        });
        const repo = getTarget(config, targets[0]!.name).ci!.repo;
        const commands = variables
          .filter((v) => v.value !== null)
          .map((v) => `gh variable set ${v.name} --repo ${repo} --body ${v.value}`);
        const missing = [
          ...new Set(variables.filter((v) => v.value === null).map((v) => v.target)),
        ];

        const lines = [
          ...created.map((f) => `Wrote ${f}`),
          ...skipped.map((f) => `Kept ${f} (it exists; --force overwrites it)`),
        ];
        for (const t of targets) {
          lines.push(
            `${t.name}: deploys on push to ${t.branch}` +
              (t.environment === undefined ? '' : ` in environment "${t.environment}"`) +
              (t.previews ? ', previews pull requests' : ''),
          );
        }
        if (commands.length > 0) {
          lines.push('', 'Set the repository variables (identifiers, not secrets):', ...commands);
        }
        if (missing.length > 0) {
          lines.push(
            '',
            `Provision ${missing.join(', ')} first (\`sforge provision <target>\`), then run this again for the variables.`,
          );
        }
        const environments = [...new Set(targets.flatMap((t) => t.environment ?? []))];
        if (environments.length > 0) {
          lines.push(
            '',
            `Create the GitHub environment${environments.length > 1 ? 's' : ''} ${environments.join(', ')} with required reviewers (Settings → Environments).`,
          );
        }
        lines.push(
          'Commit .sforge/iac/<target>/.terraform.lock.hcl too: CI reads the outputs with the same providers.',
        );

        return {
          data: {
            directory: toPosix(relative(repoDir, dir)),
            created,
            skipped,
            targets,
            variables,
            commands,
          },
          text: lines.join('\n'),
        };
      }),
    );
}
