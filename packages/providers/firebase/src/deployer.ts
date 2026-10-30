import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gzip as gzipCallback } from 'node:zlib';
import { ErrorCode, type FirebaseTargetConfig, SforgeError } from '@staticforge/core';
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
  gitShortSha,
  mapLimit,
  newVersionId,
  publishedFiles,
  readManifest,
} from '@staticforge/provider-api';
import {
  type FirebaseClients,
  type HostingApi,
  type HostingChannel,
  type HostingRelease,
  type HostingVersion,
  defaultClients,
  firebaseError,
} from './client.js';
import { assertPublic, siteId } from './iac.js';
import { generateServingConfig } from './serving-config.js';

/** Outputs of terraform/modules/site the deployer needs. */
export const REQUIRED_OUTPUTS = ['project', 'site_id', 'url'];

/** The channel production is served from. */
const LIVE = 'live';
const CONCURRENCY = 16;
/** populateFiles takes this many paths per call (the batch size firebase-tools uses). */
const POPULATE_BATCH = 1000;

/** Labels hold lowercase letters, digits, "-" and "_", so version ids go in lowercased. */
const VERSION_LABEL = 'sforge-version';
const SHA_LABEL = 'sforge-sha';

const gzip = promisify(gzipCallback);

const gzipped = (data: Uint8Array) => gzip(data, { level: 9 });

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

const lastSegment = (name: string): string => name.slice(name.lastIndexOf('/') + 1);

/** sforge's id of a version; a version deployed some other way goes by Firebase's. */
function versionIdOf(version: HostingVersion): string {
  const label = version.labels?.[VERSION_LABEL];
  if (label === undefined) return lastSegment(version.name);
  return label.replace(/^(\d{8})t(\d{6})z-/, '$1T$2Z-');
}

const isServable = (version: HostingVersion | undefined): version is HostingVersion =>
  version?.status === undefined || version.status === 'FINALIZED';

/** The version the channel serves: its newest release, unless that disabled the site. */
const activeOf = (releases: HostingRelease[]): HostingVersion | undefined =>
  releases[0]?.type === 'SITE_DISABLE' ? undefined : releases[0]?.version;

export function createFirebaseDeployer(
  context: DeployerContext,
  clients: FirebaseClients = defaultClients(),
): Deployer {
  const target = context.target as FirebaseTargetConfig;
  const name = context.targetName;
  assertPublic(target, name);

  const output = (key: string): string => {
    const value = context.outputs[key];
    if (typeof value !== 'string' || value === '') {
      throw new SforgeError(ErrorCode.NotProvisioned, `"${name}" has no "${key}" output`, {
        hint: `Run \`sforge provision ${name}\` first.`,
      });
    }
    return value;
  };
  const site = () =>
    typeof context.outputs.site_id === 'string'
      ? context.outputs.site_id
      : siteId(target, projectName(context.config), name);
  const url = () => output('url');
  const ttlSeconds = target.previewTtlDays * 24 * 60 * 60;

  let opened: Promise<HostingApi> | undefined;
  function open(): Promise<HostingApi> {
    opened ??= clients.assertSignedIn(target.project).then(() => clients.hosting(target.project));
    return opened;
  }

  function assertChannel(previewId: string): void {
    assertPreviewId(previewId);
    if (previewId === LIVE) {
      throw new SforgeError(ErrorCode.Usage, `"${LIVE}" is the production channel`, {
        hint: 'Use a preview id such as "pr-42".',
      });
    }
  }

  /** The channel of a preview, created if needed; each deploy restarts its time to live. */
  async function ensureChannel(api: HostingApi, previewId: string): Promise<HostingChannel> {
    const existing = await api.getChannel(site(), previewId);
    return existing === undefined
      ? api.createChannel(site(), previewId, ttlSeconds)
      : api.setChannelTtl(site(), previewId, ttlSeconds);
  }

  /** Keep `retainVersions`: the setting lives on the site and Terraform has no resource for it. */
  async function applyRetention(api: HostingApi): Promise<void> {
    if ((await api.getMaxVersions(site())) !== target.retainVersions) {
      await api.setMaxVersions(site(), target.retainVersions);
    }
  }

  /** Hash the files as Firebase does (SHA-256 of the gzipped bytes). */
  async function hashFiles(buildDir: string, paths: string[]) {
    const hashes = new Map<string, string>();
    const sources = new Map<string, string>();
    await mapLimit(paths, CONCURRENCY, async (path) => {
      const hash = sha256(await gzipped(await readFile(join(buildDir, path))));
      hashes.set(path, hash);
      sources.set(hash, path);
    });
    return { hashes, sources };
  }

  /** Tell Firebase the files of the version, then send the ones it does not have. */
  async function upload(
    api: HostingApi,
    version: string,
    buildDir: string,
    paths: string[],
  ): Promise<number> {
    const { hashes, sources } = await hashFiles(buildDir, paths);
    const required = new Set<string>();
    let uploadUrl: string | undefined;
    for (let start = 0; start < paths.length; start += POPULATE_BATCH) {
      const files = Object.fromEntries(
        paths.slice(start, start + POPULATE_BATCH).map((path) => [`/${path}`, hashes.get(path)!]),
      );
      const result = await api.populateFiles(version, files);
      for (const hash of result.uploadRequiredHashes) required.add(hash);
      uploadUrl = result.uploadUrl ?? uploadUrl;
    }
    if (required.size === 0) return 0;
    if (uploadUrl === undefined) {
      throw new SforgeError(ErrorCode.DeployFailed, 'Firebase asked for files but no upload URL');
    }
    const destination = uploadUrl;
    await mapLimit([...required], CONCURRENCY, async (hash) => {
      const path = sources.get(hash);
      if (path === undefined) {
        throw new SforgeError(ErrorCode.DeployFailed, `Firebase asked for an unknown file ${hash}`);
      }
      await api.upload(destination, hash, await gzipped(await readFile(join(buildDir, path))));
    });
    return required.size;
  }

  async function publish(deployOptions: DeployOptions): Promise<DeployResult> {
    const { buildDir, preview } = deployOptions;
    if (preview !== undefined) assertChannel(preview);

    const manifest = readManifest(buildDir);
    const files = publishedFiles(manifest);
    const paths = files.map(([path]) => path);
    const bytes = files.reduce((sum, [, entry]) => sum + entry.size, 0);
    const generated = generateServingConfig(context.config, manifest);
    if (generated.droppedRules > 0) {
      context.logger.warn(
        `${generated.droppedRules} fingerprinted files are not cached for a year: too many separate files to list`,
      );
    }

    const now = deployOptions.now ?? new Date();
    const sha = deployOptions.gitSha ?? gitShortSha(context.rootDir, context.env);
    const versionId = preview ?? newVersionId(now, sha);
    const base = {
      target: name,
      provider: 'firebase' as const,
      versionId,
      preview: preview !== undefined,
      uploaded: paths.length,
      copied: 0,
      skipped: 0,
      deleted: 0,
      bytes,
      pruned: [] as string[],
      // Firebase clears its CDN on every release.
      invalidated: false,
    };
    const api = await open();
    if (deployOptions.dryRun === true) {
      const existing = preview === undefined ? undefined : await api.getChannel(site(), preview);
      return { ...base, url: existing?.url ?? url(), dryRun: true };
    }

    const channel = preview ?? LIVE;
    let serveUrl = url();
    let previous: HostingVersion | undefined;
    let versionName: string | undefined;
    try {
      if (preview === undefined) {
        await applyRetention(api);
        previous = activeOf(await api.listReleases(site(), LIVE));
      } else {
        serveUrl = (await ensureChannel(api, preview)).url ?? serveUrl;
      }
      const version = await api.createVersion(site(), {
        config: generated.config,
        labels: {
          [VERSION_LABEL]: versionId.toLowerCase(),
          ...(sha !== undefined && { [SHA_LABEL]: sha.toLowerCase() }),
        },
      });
      versionName = version.name;
      context.logger.info(`Uploading ${paths.length} files to ${channel}`);
      const sent = await upload(api, version.name, buildDir, paths);
      await api.setVersionStatus(version.name, 'FINALIZED');
      await api.createRelease(site(), channel, version.name, `sforge ${versionId}`);
      return {
        ...base,
        url: serveUrl,
        uploaded: sent,
        // Firebase keeps what it has seen by content, across versions and sites.
        copied: paths.length - sent,
        dryRun: false,
        ...(previous !== undefined && { previousVersionId: versionIdOf(previous) }),
      };
    } catch (error) {
      // Leave no half-made version behind; a failure here changes nothing for the visitor.
      if (versionName !== undefined) {
        await api.setVersionStatus(versionName, 'ABANDONED').catch(() => undefined);
      }
      throw firebaseError(error, `Could not deploy to ${channel}`);
    }
  }

  async function productionVersions(api: HostingApi) {
    let releases: HostingRelease[];
    try {
      releases = await api.listReleases(site(), LIVE);
    } catch (error) {
      throw firebaseError(error, 'Could not list the releases');
    }
    const active = activeOf(releases);
    const byName = new Map<string, HostingVersion>();
    for (const release of releases) {
      const version = release.version;
      // Firebase deletes versions beyond the site's limit; their releases stay listed.
      if (isServable(version) && !byName.has(version.name)) byName.set(version.name, version);
    }
    const versions = [...byName.values()].sort((a, b) =>
      (b.createTime ?? '').localeCompare(a.createTime ?? ''),
    );
    return { versions, active };
  }

  return {
    deploy: publish,

    async versions(): Promise<DeployedVersion[]> {
      const api = await open();
      const { versions, active } = await productionVersions(api);
      const production = versions.map((v): DeployedVersion => {
        const sha = v.labels?.[SHA_LABEL];
        return {
          id: versionIdOf(v),
          createdAt: v.createTime ?? '',
          ...(sha !== undefined && { gitSha: sha }),
          files: Number(v.fileCount ?? 0),
          bytes: Number(v.versionBytes ?? 0),
          active: v.name === active?.name,
          preview: false,
        };
      });
      let channels: HostingChannel[];
      try {
        channels = await api.listChannels(site());
      } catch (error) {
        throw firebaseError(error, 'Could not list the preview channels');
      }
      const previews = channels
        .filter((c) => lastSegment(c.name) !== LIVE)
        .map((c): DeployedVersion => ({
          id: lastSegment(c.name),
          createdAt: c.createTime ?? '',
          files: Number(c.release?.version?.fileCount ?? 0),
          bytes: Number(c.release?.version?.versionBytes ?? 0),
          active: false,
          preview: true,
          ...(c.url !== undefined && { url: c.url }),
        }))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return [...production, ...previews];
    },

    async rollback(to?: string): Promise<RollbackResult> {
      const api = await open();
      const { versions, active } = await productionVersions(api);
      if (active === undefined) {
        throw new SforgeError(ErrorCode.VersionNotFound, `Nothing is live on "${name}" yet`);
      }
      const activeIndex = versions.findIndex((v) => v.name === active.name);
      const wanted =
        to === undefined
          ? versions[activeIndex + 1]
          : versions.find(
              (v) =>
                versionIdOf(v) === to ||
                (to.length >= 4 && v.labels?.[SHA_LABEL]?.startsWith(to) === true),
            );
      if (wanted === undefined) {
        throw new SforgeError(
          ErrorCode.VersionNotFound,
          to === undefined
            ? 'There is no earlier version to roll back to'
            : `No deployed version matches "${to}"`,
          { hint: 'See `sforge versions`; Firebase keeps the last `retainVersions` deploys.' },
        );
      }
      if (wanted.name === active.name) {
        throw new SforgeError(ErrorCode.Usage, `${versionIdOf(wanted)} is already active`);
      }
      try {
        await api.createRelease(
          site(),
          LIVE,
          wanted.name,
          `sforge rollback to ${versionIdOf(wanted)}`,
        );
      } catch (error) {
        throw firebaseError(error, `Could not roll back to ${versionIdOf(wanted)}`);
      }
      return {
        target: name,
        versionId: versionIdOf(wanted),
        previousVersionId: versionIdOf(active),
        url: url(),
      };
    },

    async destroyPreview(previewId: string): Promise<PreviewDestroyResult> {
      assertChannel(previewId);
      const api = await open();
      try {
        const existed = await api.deleteChannel(site(), previewId);
        return { target: name, previewId, deleted: 0, existed };
      } catch (error) {
        throw firebaseError(error, `Could not remove the preview ${previewId}`);
      }
    },

    async current() {
      const api = await open();
      try {
        const active = activeOf(await api.listReleases(site(), LIVE));
        return { url: url(), versionId: active === undefined ? null : versionIdOf(active) };
      } catch (error) {
        throw firebaseError(error, 'Could not list the releases');
      }
    },

    /**
     * The URL has a hash that only Firebase knows, so a real deploy creates the channel now.
     * A dry run must not: it reads the channel, and builds with the site's URL without one.
     */
    async previewBaseUrl(previewId, options) {
      assertChannel(previewId);
      const api = await open();
      try {
        const channel =
          options?.dryRun === true
            ? await api.getChannel(site(), previewId)
            : await ensureChannel(api, previewId);
        return channel?.url;
      } catch (error) {
        throw firebaseError(error, `Could not prepare the preview ${previewId}`);
      }
    },
  };
}
