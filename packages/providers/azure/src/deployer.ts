import { constants, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { WebSiteManagementClient } from '@azure/arm-appservice';
import { type AzureTargetConfig, ErrorCode, SforgeError } from '@staticforge/core';
import { projectName } from '@staticforge/iac';
import {
  type DeployOptions,
  type DeployResult,
  type DeployedVersion,
  type Deployer,
  type DeployerContext,
  type PreviewDestroyResult,
  type RollbackResult,
  assertPreviewId,
  gitIsDirty,
  gitShortSha,
  newVersionId,
  publishedFiles,
  readManifest,
} from '@staticforge/provider-api';
import { type AzureClients, azureError, defaultClients } from './clients.js';
import { HistoryConflict, type HistoryStore, type VersionEntry } from './history.js';
import { assertSignedIn, historyBlobName, resolveSubscription, stateLocation } from './iac.js';
import { type Rebuild, rebuildAtCommit } from './rebuild.js';
import { SWA_CONFIG_FILE, generateStaticWebAppConfig } from './swa-config.js';
import { type Uploader, swaCliUploader } from './uploader.js';

/** Outputs of terraform/modules/site the deployer needs. */
export const REQUIRED_OUTPUTS = [
  'static_web_app_name',
  'resource_group',
  'default_host_name',
  'url',
  'location',
];

/** Static Web Apps limits (https://learn.microsoft.com/azure/static-web-apps/quotas). */
const MAX_FILES = 15_000;
const FREE_MAX_BYTES = 250 * 1024 * 1024;

/** ARM calls the production environment "default". */
const PRODUCTION_BUILD = 'default';
const READY_TIMEOUT_MS = 5 * 60_000;
const READY_POLL_MS = 3_000;
/** The deploy client and Azure's clocks may differ a little. */
const CLOCK_SKEW_MS = 30_000;
const HISTORY_ATTEMPTS = 4;

export interface AzureDeployerOptions {
  uploader?: Uploader;
  rebuild?: Rebuild;
  /** Milliseconds between checks that an upload went live. */
  pollIntervalMs?: number;
  readyTimeoutMs?: number;
}

interface Build {
  buildId: string;
  hostname: string | undefined;
  status: string | undefined;
  createdAt: Date | undefined;
  updatedAt: Date | undefined;
}

interface Session {
  sites: StaticSites;
  history: HistoryStore;
}

interface PublishExtras {
  rollbackOf?: string;
  dirty?: boolean;
}

type StaticSites = WebSiteManagementClient['staticSites'];

/**
 * The name Azure gives a preview environment: it keeps lowercase letters and digits
 * only, so "pr-42" becomes "pr42" (and so does the host name).
 */
export const previewEnvironment = (id: string): string =>
  id.toLowerCase().replace(/[^a-z0-9]/g, '');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createAzureDeployer(
  context: DeployerContext,
  clients: AzureClients = defaultClients(),
  options: AzureDeployerOptions = {},
): Deployer {
  const target = context.target as AzureTargetConfig;
  const project = projectName(context.config);
  const uploader = options.uploader ?? swaCliUploader;
  const rebuild = options.rebuild ?? rebuildAtCommit;

  const output = (key: string): string => {
    const value = context.outputs[key];
    if (typeof value !== 'string' || value === '') {
      throw new SforgeError(
        ErrorCode.NotProvisioned,
        `"${context.targetName}" has no "${key}" output`,
        { hint: `Run \`sforge provision ${context.targetName}\` first.` },
      );
    }
    return value;
  };
  const appName = () => output('static_web_app_name');
  const resourceGroup = () => output('resource_group');

  let session: Promise<Session> | undefined;
  function open(): Promise<Session> {
    session ??= (async () => {
      const subscriptionId = await resolveSubscription(clients, target, context.env);
      await assertSignedIn(clients);
      const state = stateLocation(target, subscriptionId, project, context.targetName);
      return {
        sites: clients.webSites(subscriptionId).staticSites,
        history: clients.history(
          state.storageAccount,
          state.container,
          historyBlobName(project, context.targetName),
        ),
      };
    })();
    return session;
  }

  async function builds(sites: StaticSites): Promise<Build[]> {
    try {
      const found: Build[] = [];
      for await (const b of sites.listStaticSiteBuilds(resourceGroup(), appName())) {
        found.push({
          buildId: b.buildId ?? '',
          hostname: b.hostname,
          status: b.status,
          createdAt: b.createdTimeUtc,
          updatedAt: b.lastUpdatedOn,
        });
      }
      return found;
    } catch (error) {
      throw azureError(error, 'Could not list the environments of the Static Web App');
    }
  }

  /** The environment is live once ARM reports it Ready after the upload started. */
  async function waitUntilLive(sites: StaticSites, environment: string, since: number) {
    const buildId =
      environment === 'production' ? PRODUCTION_BUILD : previewEnvironment(environment);
    const deadline = Date.now() + (options.readyTimeoutMs ?? READY_TIMEOUT_MS);
    for (;;) {
      const build = (await builds(sites)).find((b) => b.buildId === buildId);
      const changed = (build?.updatedAt ?? build?.createdAt)?.getTime() ?? 0;
      if (build?.status === 'Ready' && changed >= since - CLOCK_SKEW_MS) return build;
      if (build?.status === 'Failed') {
        throw new SforgeError(ErrorCode.DeployFailed, `Azure reports the deployment as failed`, {
          hint: 'Look at the Static Web App in the Azure portal (Environments) for details.',
        });
      }
      if (Date.now() > deadline) {
        throw new SforgeError(
          ErrorCode.DeployFailed,
          `The deployment was uploaded but is not live after ${Math.round((options.readyTimeoutMs ?? READY_TIMEOUT_MS) / 1000)}s (status: ${build?.status ?? 'unknown'})`,
          { hint: 'It may still finish: check `sforge versions`, or the Azure portal.' },
        );
      }
      await sleep(options.pollIntervalMs ?? READY_POLL_MS);
    }
  }

  async function deploymentToken(sites: StaticSites): Promise<string> {
    try {
      const secrets = await sites.listStaticSiteSecrets(resourceGroup(), appName());
      const token = secrets.properties?.apiKey;
      if (token === undefined || token === '') throw new Error('the app has no deployment token');
      return token;
    } catch (error) {
      throw azureError(error, 'Could not get the deployment token of the Static Web App');
    }
  }

  /** Record a production deploy; retries when another deploy updated the history meanwhile. */
  async function record(history: HistoryStore, entry: VersionEntry) {
    for (let attempt = 1; attempt <= HISTORY_ATTEMPTS; attempt++) {
      try {
        const { doc, etag } = await history.read();
        const previous = doc.active;
        const all = [entry, ...doc.versions.filter((v) => v.id !== entry.id)];
        const kept = all.slice(0, target.retainVersions);
        await history.write({ schema: 1, active: entry.id, versions: kept }, etag);
        return { previous, pruned: all.slice(kept.length).map((v) => v.id) };
      } catch (error) {
        if (!(error instanceof HistoryConflict)) {
          throw azureError(error, 'The site is live, but its deploy history could not be updated');
        }
      }
    }
    throw new SforgeError(
      ErrorCode.DeployFailed,
      'The site is live, but its deploy history could not be updated: other deploys kept changing it',
      { hint: 'Deploy again.' },
    );
  }

  /** Copy the publishable files (no dot-paths such as .sforge/) and the generated config. */
  function stage(buildDir: string, paths: string[], configJson: string | undefined): string {
    const root = mkdtempSync(join(tmpdir(), 'sforge-azure-'));
    const site = join(root, 'site');
    mkdirSync(site, { recursive: true });
    for (const path of paths) {
      const destination = join(site, path);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(buildDir, path), destination, constants.COPYFILE_FICLONE);
    }
    if (configJson !== undefined) writeFileSync(join(site, SWA_CONFIG_FILE), configJson);
    return root;
  }

  function previewHost(id: string): string {
    // <app>-<id>.<region>.<rest of the default host name>
    const [first = '', ...rest] = output('default_host_name').split('.');
    return `${first}-${previewEnvironment(id)}.${output('location')}.${rest.join('.')}`;
  }

  async function publish(
    deployOptions: DeployOptions,
    extras: PublishExtras,
  ): Promise<DeployResult> {
    const { buildDir, preview } = deployOptions;
    if (preview !== undefined) assertPreviewId(preview);

    const manifest = readManifest(buildDir);
    const files = publishedFiles(manifest);
    const generated = generateStaticWebAppConfig(context.config, manifest);
    const ownConfig = manifest.files[SWA_CONFIG_FILE] !== undefined;
    if (ownConfig) {
      context.logger.warn(
        `static/${SWA_CONFIG_FILE} is used as it is: sforge's security headers, cache rules and 404 page are not added`,
      );
    } else if (generated.droppedRoutes > 0) {
      context.logger.warn(
        `${generated.droppedRoutes} fingerprinted files are not cached for a year: Static Web Apps limits ${SWA_CONFIG_FILE} to 20 KB`,
      );
    }

    const fileCount = files.length + (ownConfig ? 0 : 1);
    const bytes = files.reduce((sum, [, entry]) => sum + entry.size, 0);
    if (fileCount > MAX_FILES) {
      throw new SforgeError(
        ErrorCode.DeployFailed,
        `The site has ${fileCount} files; Static Web Apps allows ${MAX_FILES} per app`,
      );
    }
    if (target.sku === 'Free' && bytes > FREE_MAX_BYTES) {
      throw new SforgeError(
        ErrorCode.DeployFailed,
        `The site is ${Math.round(bytes / 1024 / 1024)} MB; the Free plan allows ${FREE_MAX_BYTES / 1024 / 1024} MB per environment`,
        { hint: 'Reduce the size of images and videos, or set sku: "Standard".' },
      );
    }

    const now = deployOptions.now ?? new Date();
    const sha = deployOptions.gitSha ?? gitShortSha(context.rootDir, context.env);
    const versionId = preview ?? newVersionId(now, sha);
    const environment = preview ?? 'production';
    const base = {
      target: context.targetName,
      provider: 'azure' as const,
      versionId,
      preview: preview !== undefined,
      uploaded: fileCount,
      copied: 0,
      skipped: 0,
      deleted: 0,
      bytes,
      pruned: [] as string[],
      invalidated: false,
    };
    if (deployOptions.dryRun === true) {
      return {
        ...base,
        url: preview === undefined ? output('url') : `https://${previewHost(preview)}`,
        dryRun: true,
      };
    }

    const { sites, history } = await open();
    const token = await deploymentToken(sites);
    const staging = stage(
      buildDir,
      files.map(([path]) => path),
      ownConfig ? undefined : generated.json,
    );
    const startedAt = Date.now();
    let reported: string | undefined;
    try {
      context.logger.info(`Uploading ${fileCount} files to ${environment}`);
      reported = (
        await uploader({
          dir: join(staging, 'site'),
          environment,
          token,
          env: context.env,
        })
      ).url;
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    const live = await waitUntilLive(sites, environment, startedAt);
    const url =
      preview === undefined
        ? output('url')
        : `https://${live.hostname ?? reported?.replace(/^https:\/\//, '') ?? previewHost(preview)}`;

    if (preview !== undefined) return { ...base, url, dryRun: false };

    const { previous, pruned } = await record(history, {
      id: versionId,
      createdAt: now.toISOString(),
      ...(sha !== undefined && { gitSha: sha }),
      ...((extras.dirty ?? gitIsDirty(context.rootDir)) && { dirty: true }),
      files: fileCount,
      bytes,
      ...(extras.rollbackOf !== undefined && { rollbackOf: extras.rollbackOf }),
    });
    return {
      ...base,
      url,
      pruned,
      dryRun: false,
      ...(previous !== null && { previousVersionId: previous }),
    };
  }

  return {
    deploy: (deployOptions) => publish(deployOptions, {}),

    async versions(): Promise<DeployedVersion[]> {
      const { sites, history } = await open();
      let doc;
      try {
        doc = (await history.read()).doc;
      } catch (error) {
        throw azureError(error, 'Could not read the deploy history');
      }
      const production: DeployedVersion[] = doc.versions.map((v) => ({
        id: v.id,
        createdAt: v.createdAt,
        ...(v.gitSha !== undefined && { gitSha: v.gitSha }),
        files: v.files,
        bytes: v.bytes,
        active: v.id === doc.active,
        preview: false,
      }));
      const previews: DeployedVersion[] = (await builds(sites))
        .filter((b) => b.buildId !== PRODUCTION_BUILD && b.buildId !== '')
        .map((b) => ({
          id: b.buildId,
          createdAt: (b.createdAt ?? b.updatedAt)?.toISOString() ?? '',
          files: 0,
          bytes: 0,
          active: false,
          preview: true,
          ...(b.hostname !== undefined && { url: `https://${b.hostname}` }),
        }))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return [...production, ...previews];
    },

    async rollback(to?: string): Promise<RollbackResult> {
      const { history } = await open();
      let doc;
      try {
        doc = (await history.read()).doc;
      } catch (error) {
        throw azureError(error, 'Could not read the deploy history');
      }
      const activeIndex = doc.versions.findIndex((v) => v.id === doc.active);
      if (activeIndex === -1) {
        throw new SforgeError(
          ErrorCode.VersionNotFound,
          `Nothing has been deployed to "${context.targetName}" yet`,
        );
      }
      const wanted =
        to === undefined
          ? doc.versions[activeIndex + 1]
          : doc.versions.find(
              (v) => v.id === to || (to.length >= 4 && v.gitSha?.startsWith(to) === true),
            );
      if (wanted === undefined) {
        throw new SforgeError(
          ErrorCode.VersionNotFound,
          to === undefined
            ? 'There is no earlier version to roll back to'
            : `No deployed version matches "${to}"`,
          { hint: 'See `sforge versions`; Azure keeps the last `retainVersions` deploys.' },
        );
      }
      if (wanted.id === doc.active) {
        throw new SforgeError(ErrorCode.Usage, `${wanted.id} is already the active version`);
      }
      if (wanted.gitSha === undefined || wanted.gitSha === 'local' || wanted.dirty === true) {
        throw new SforgeError(
          ErrorCode.Unsupported,
          `${wanted.id} cannot be rebuilt: it was deployed ${wanted.dirty === true ? 'with uncommitted changes' : 'outside a git repository'}`,
          {
            hint: 'Azure rollbacks rebuild the site from the commit. Roll back to a version deployed from a clean checkout, or fix forward.',
          },
        );
      }

      const rebuilt = await rebuild(wanted.gitSha, context);
      try {
        const result = await publish(
          { buildDir: rebuilt.buildDir, gitSha: wanted.gitSha },
          { rollbackOf: wanted.id, dirty: false },
        );
        return {
          target: context.targetName,
          versionId: result.versionId,
          previousVersionId: doc.active,
          url: result.url,
        };
      } finally {
        rebuilt.cleanup();
      }
    },

    async destroyPreview(previewId: string): Promise<PreviewDestroyResult> {
      assertPreviewId(previewId);
      const { sites } = await open();
      const environment = previewEnvironment(previewId);
      const exists = (await builds(sites)).some((b) => b.buildId === environment);
      if (exists) {
        try {
          const poller = sites.deleteStaticSiteBuild(resourceGroup(), appName(), environment);
          await poller.pollUntilDone();
        } catch (error) {
          throw azureError(error, `Could not remove the preview ${previewId}`);
        }
      }
      return { target: context.targetName, previewId, deleted: 0, existed: exists };
    },

    async current() {
      const { history } = await open();
      try {
        return { url: output('url'), versionId: (await history.read()).doc.active };
      } catch (error) {
        throw azureError(error, 'Could not read the deploy history');
      }
    },

    previewBaseUrl: (previewId) => `https://${previewHost(previewId)}`,
  };
}
