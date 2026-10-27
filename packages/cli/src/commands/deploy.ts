import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import type { CheckBuildOptions } from '@staticforge/checker';
import {
  ErrorCode,
  SforgeError,
  type WorkerPool,
  countBySeverity,
  createWorkerPool,
  formatDiagnostic,
  poolSize,
  targetBaseUrl,
} from '@staticforge/core';
import type { DeployResult } from '@staticforge/provider-api';
import { type Runtime, action } from '../command.js';
import { confirmAction, deployerFor, targetContext, truthy } from '../cloud.js';
import type { CommandContext } from '../context.js';
import { displayPath } from '../paths.js';
import { loadProjectConfig } from '../project.js';
import { VERSION } from '../version.js';
import { addWorkersOption, withWorkers } from '../workers.js';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function describeDeploy(result: DeployResult): string {
  const verb = result.dryRun ? 'Would deploy' : 'Deployed';
  const lines = [
    `${verb} ${result.preview ? `preview ${result.versionId}` : `version ${result.versionId}`} to "${result.target}": ` +
      `${result.uploaded} uploaded (${formatBytes(result.bytes)}), ${result.copied} copied, ` +
      `${result.skipped} unchanged, ${result.deleted} removed`,
  ];
  if (result.pruned.length > 0) lines.push(`Removed old versions: ${result.pruned.join(', ')}`);
  if (result.invalidated) lines.push('Invalidated the CloudFront cache (/*).');
  lines.push(`${result.dryRun ? 'Would be live' : 'Live'} at ${result.url}`);
  return lines.join('\n');
}

/** Run the checker on a finished build; throw SF_CHECK_FAILED at or above check.failOn. */
async function checkBeforeDeploy(
  ctx: CommandContext,
  options: Pick<CheckBuildOptions, 'rootDir' | 'config' | 'build'> & {
    headless?: boolean;
    pool?: WorkerPool;
  },
) {
  const { checkBuild, finalizeDiagnostics } = await import('@staticforge/checker');
  const { config } = options;
  const headless = options.headless ?? config.check.headless;
  const checked = await checkBuild({
    rootDir: options.rootDir,
    config,
    build: options.build,
    headless,
    requireBrowser: options.headless === true || truthy(ctx.io.env.CI),
    ...(ctx.io.env.SFORGE_CHROMIUM_PATH && { executablePath: ctx.io.env.SFORGE_CHROMIUM_PATH }),
    ...(options.pool && { pool: options.pool }),
    logger: ctx.logger,
  });
  const diagnostics = finalizeDiagnostics(checked.findings, config.check.ignore);
  const summary = countBySeverity(diagnostics);
  const failing = diagnostics.filter(
    (d) =>
      d.severity === 'error' || (config.check.failOn === 'warning' && d.severity === 'warning'),
  );
  if (failing.length > 0) {
    if (!ctx.json) for (const d of failing) ctx.logger.error(formatDiagnostic(d));
    throw new SforgeError(
      ErrorCode.CheckFailed,
      `The check found ${failing.length} problem${failing.length === 1 ? '' : 's'} at or above "${config.check.failOn}"; nothing was deployed`,
      {
        details: { summary, diagnostics: failing },
        hint: 'Fix them (see `sforge check`), or deploy anyway with --no-check.',
      },
    );
  }
  return { summary, rendered: checked.rendered };
}

export function registerDeployCommands(program: Command, runtime: Runtime): void {
  addWorkersOption(
    program
      .command('deploy')
      .description('Build, check and deploy the site to a provisioned target')
      .argument('<target>', 'target name from the config')
      .option('--preview <id>', 'deploy a PR preview (e.g. pr-42) instead of production')
      .option('--no-build', 'deploy the existing build in build.outDir')
      .option('--no-check', 'deploy even if `sforge check` would fail')
      .option('--headless', 'run rendered checks in headless Chromium (default: check.headless)')
      .option('--no-headless', 'skip rendered checks')
      .option('--invalidate', 'invalidate the CDN cache afterwards (normally unnecessary)')
      .option('--dry-run', 'show what would be uploaded, change nothing'),
  ).action(
    action(runtime, async (ctx, { args, options }) => {
      const loaded = await loadProjectConfig(ctx);
      const { rootDir } = loaded;
      const config = withWorkers(loaded.config, options);
      const target = await targetContext(runtime, ctx, loaded, args[0] as string);
      const preview = options.preview as string | undefined;
      if (preview !== undefined)
        (await import('@staticforge/provider-api')).assertPreviewId(preview);
      const deployer = await deployerFor(ctx, target);

      const outDir = resolve(rootDir, config.build.outDir);
      const previewBaseUrl = preview === undefined ? undefined : deployer.previewBaseUrl?.(preview);
      // Previews get their own canonical URLs, feeds and sitemap; production gets the target's.
      const baseUrl =
        preview === undefined ? targetBaseUrl(config, target.targetName) : previewBaseUrl;
      let check: Awaited<ReturnType<typeof checkBeforeDeploy>> | undefined;
      if (options.build !== false) {
        // One pool for the build and the check.
        const size = poolSize(config.build.workers);
        const pool = size > 0 ? createWorkerPool(size) : undefined;
        try {
          const { buildSite } = await import('@staticforge/build');
          const build = await buildSite({
            rootDir,
            config,
            ...(baseUrl !== undefined && { baseUrl }),
            // Previews live on public URLs (and in PR comments), and private sites are
            // nobody's business: keep both out of search results.
            ...((preview !== undefined || target.target.auth !== undefined) && { noindex: true }),
            generator: `staticforge ${VERSION}`,
            logger: ctx.logger,
            ...(pool && { pool }),
          });
          if (!build.ok) {
            throw new SforgeError(ErrorCode.CheckFailed, 'The build failed; nothing was deployed', {
              details: { diagnostics: build.diagnostics.filter((d) => d.severity === 'error') },
            });
          }
          if (options.check !== false) {
            check = await checkBeforeDeploy(ctx, {
              rootDir,
              config,
              build,
              ...(options.headless !== undefined && { headless: options.headless as boolean }),
              ...(pool && { pool }),
            });
          }
        } finally {
          await pool?.close();
        }
      } else {
        ctx.logger.warn('--no-build: deploying the existing build, which is not checked again');
      }

      const result = await deployer.deploy({
        buildDir: outDir,
        ...(preview !== undefined && { preview }),
        invalidate: options.invalidate === true,
        dryRun: options.dryRun === true,
      });
      return {
        data: { ...result, buildDir: outDir, ...(check && { check }) },
        text: `${describeDeploy(result)}\nBuild: ${displayPath(ctx.cwd, join(outDir))}`,
      };
    }),
  );

  program
    .command('versions')
    .description('List the deployed versions and previews of a target')
    .argument('<target>', 'target name from the config')
    .action(
      action(runtime, async (ctx, { args }) => {
        const loaded = await loadProjectConfig(ctx);
        const target = await targetContext(runtime, ctx, loaded, args[0] as string);
        const versions = await (await deployerFor(ctx, target)).versions();
        const rows = versions.map(
          (v) =>
            `${v.active ? '*' : ' '} ${v.id.padEnd(28)} ${v.createdAt}  ${String(v.files).padStart(5)} files  ${formatBytes(v.bytes)}` +
            (v.preview ? `  preview${v.url ? ` ${v.url}` : ''}` : ''),
        );
        return {
          data: { target: target.targetName, versions },
          text:
            rows.length > 0
              ? rows.join('\n')
              : `Nothing has been deployed to "${target.targetName}".`,
        };
      }),
    );

  program
    .command('rollback')
    .description('Serve an earlier version again (default: the one before the active version)')
    .argument('<target>', 'target name from the config')
    .option('--to <versionId>', 'version to serve (see `sforge versions`)')
    .option('-y, --yes', 'roll back without asking')
    .action(
      action(runtime, async (ctx, { args, options }) => {
        const loaded = await loadProjectConfig(ctx);
        const target = await targetContext(runtime, ctx, loaded, args[0] as string);
        const deployer = await deployerFor(ctx, target);
        const to = options.to as string | undefined;
        await confirmAction(
          ctx,
          options.yes === true,
          `Roll "${target.targetName}" back to ${to ?? 'the previous version'}?`,
        );
        const result = await deployer.rollback(to);
        return {
          data: result,
          text: `"${result.target}" now serves ${result.versionId} (was ${result.previousVersionId ?? 'none'}) at ${result.url}`,
        };
      }),
    );

  program
    .command('preview-destroy')
    .description('Remove a PR preview')
    .argument('<target>', 'target name from the config')
    .argument('<id>', 'preview id, e.g. pr-42')
    .action(
      action(runtime, async (ctx, { args }) => {
        const loaded = await loadProjectConfig(ctx);
        const target = await targetContext(runtime, ctx, loaded, args[0] as string);
        const result = await (await deployerFor(ctx, target)).destroyPreview(args[1] as string);
        return {
          data: result,
          text: result.existed
            ? `Removed preview ${result.previewId}${result.deleted > 0 ? ` (${result.deleted} files)` : ''}`
            : result.deleted > 0
              ? `No preview ${result.previewId} was recorded; removed ${result.deleted} leftover files`
              : `No preview ${result.previewId} exists`,
        };
      }),
    );
}
