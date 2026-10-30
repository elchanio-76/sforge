import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { type SforgeConfig, createLogger, validateConfig } from '@staticforge/core';
import type { DeployerContext } from '@staticforge/provider-api';
import type {
  FirebaseClients,
  HostingApi,
  HostingChannel,
  HostingCustomDomain,
  HostingRelease,
  HostingVersion,
  ServingConfig,
} from '../src/index.js';

export const PROJECT = 'sandbox-project';
export const SITE = 'docs-prod';

export function firebaseConfig(target: Record<string, unknown> = {}): SforgeConfig {
  return validateConfig({
    site: { title: 'Docs', baseUrl: 'https://docs.example.com' },
    iac: { name: 'docs' },
    targets: { prod: { provider: 'firebase', project: PROJECT, ...target } },
  });
}

export interface FakeVersion extends HostingVersion {
  config?: ServingConfig;
  files: Record<string, string>;
}

/** An in-memory Firebase Hosting: versions, releases, channels and stored content by hash. */
export interface FakeFirebase {
  clients: FirebaseClients;
  api: HostingApi;
  versions: Map<string, FakeVersion>;
  releases: Map<string, HostingRelease[]>;
  channels: Map<string, HostingChannel>;
  /** Content already stored by Firebase: hash → gunzipped text. */
  stored: Map<string, string>;
  /** Hashes uploaded in this run, in order. */
  uploads: string[];
  populateCalls: number;
  maxVersions: number | undefined;
  domain: HostingCustomDomain | undefined;
  /** Whether a state bucket exists, and what checking it does. */
  bucket: { exists: boolean; error?: unknown };
  isFirebase: boolean;
  signIn: { error?: unknown };
  /** Makes the next upload fail. */
  failUpload: { error?: unknown };
}

export function fakeFirebase(): FakeFirebase {
  let clock = Date.UTC(2026, 9, 30);
  const tick = () => new Date((clock += 1000)).toISOString();
  let nextId = 1;
  const fake: Omit<FakeFirebase, 'clients' | 'api'> = {
    versions: new Map(),
    releases: new Map(),
    channels: new Map(),
    stored: new Map(),
    uploads: [],
    populateCalls: 0,
    maxVersions: undefined,
    domain: undefined,
    bucket: { exists: true },
    isFirebase: false,
    signIn: {},
    failUpload: {},
  };
  const channelKey = (site: string, channel: string) => `${site}/${channel}`;
  const makeChannel = (site: string, channel: string): HostingChannel => ({
    name: `sites/${site}/channels/${channel}`,
    url: `https://${site}--${channel}-abc123.web.app`,
    createTime: tick(),
  });

  const api: HostingApi = {
    async createVersion(site, version) {
      const created: FakeVersion = {
        name: `sites/${site}/versions/v${nextId++}`,
        status: 'CREATED',
        labels: version.labels,
        createTime: tick(),
        config: version.config,
        files: {},
      };
      fake.versions.set(created.name, created);
      return created;
    },
    async populateFiles(versionName, files) {
      fake.populateCalls++;
      Object.assign(fake.versions.get(versionName)!.files, files);
      return {
        uploadRequiredHashes: [...new Set(Object.values(files))].filter(
          (hash) => !fake.stored.has(hash),
        ),
        uploadUrl: `https://upload.example/${versionName}/files`,
      };
    },
    async upload(_url, hash, gzipped) {
      if (fake.failUpload.error !== undefined) throw fake.failUpload.error;
      const actual = createHash('sha256').update(gzipped).digest('hex');
      if (actual !== hash) throw new Error(`Uploaded bytes hash to ${actual}, not ${hash}`);
      fake.uploads.push(hash);
      fake.stored.set(hash, gunzipSync(gzipped).toString());
    },
    async setVersionStatus(versionName, status) {
      const version = fake.versions.get(versionName)!;
      version.status = status;
      if (status === 'FINALIZED') {
        const paths = Object.values(version.files);
        version.fileCount = String(paths.length);
        version.versionBytes = String(
          paths.reduce((sum, hash) => sum + (fake.stored.get(hash)?.length ?? 0), 0),
        );
      }
    },
    async createRelease(site, channel, versionName, message) {
      const version = fake.versions.get(versionName)!;
      if (version.status !== 'FINALIZED')
        throw new Error('Only finalized versions can be released');
      const release: HostingRelease = {
        name: `sites/${site}/channels/${channel}/releases/r${nextId++}`,
        releaseTime: tick(),
        message,
        version,
      };
      const key = channelKey(site, channel);
      fake.releases.set(key, [release, ...(fake.releases.get(key) ?? [])]);
      const held = fake.channels.get(key);
      if (held !== undefined) held.release = release;
      return release;
    },
    listReleases: async (site, channel) => fake.releases.get(channelKey(site, channel)) ?? [],
    getChannel: async (site, channel) => fake.channels.get(channelKey(site, channel)),
    listChannels: async (site) => [
      { name: `sites/${site}/channels/live`, url: `https://${site}.web.app` },
      ...[...fake.channels.values()].filter((c) => c.name.startsWith(`sites/${site}/`)),
    ],
    async createChannel(site, channel, ttlSeconds) {
      const created = { ...makeChannel(site, channel), expireTime: `+${ttlSeconds}s` };
      fake.channels.set(channelKey(site, channel), created);
      return created;
    },
    async setChannelTtl(site, channel, ttlSeconds) {
      const held = fake.channels.get(channelKey(site, channel))!;
      held.expireTime = `+${ttlSeconds}s (renewed)`;
      return held;
    },
    deleteChannel: async (site, channel) => fake.channels.delete(channelKey(site, channel)),
    getMaxVersions: async () => fake.maxVersions,
    async setMaxVersions(_site, maxVersions) {
      fake.maxVersions = maxVersions;
    },
    getCustomDomain: async () => fake.domain,
  };

  const clients: FirebaseClients = {
    async assertSignedIn() {
      if (fake.signIn.error !== undefined) throw fake.signIn.error;
    },
    hosting: () => api,
    async bucketExists() {
      if (fake.bucket.error !== undefined) throw fake.bucket.error;
      return fake.bucket.exists;
    },
    isFirebaseProject: async () => fake.isFirebase,
  };
  return Object.assign(fake, { clients, api });
}

export interface BuildFile {
  content: string;
  cache?: 'immutable' | 'revalidate';
}

/** A build directory with its manifest. */
export function makeBuild(files: Record<string, BuildFile | string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'sforge-firebase-build-'));
  const manifest: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(files)) {
    const file = typeof value === 'string' ? { content: value } : value;
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.content);
    manifest[path] = {
      size: file.content.length,
      sha256: createHash('sha256').update(file.content).digest('hex'),
      cache: file.cache ?? 'revalidate',
    };
  }
  mkdirSync(join(dir, '.sforge'), { recursive: true });
  writeFileSync(
    join(dir, '.sforge', 'build-manifest.json'),
    JSON.stringify({ version: 1, files: manifest }),
  );
  return dir;
}

export function deployerContext(
  config: SforgeConfig = firebaseConfig(),
  overrides: Partial<DeployerContext> = {},
): DeployerContext {
  return {
    rootDir: mkdtempSync(join(tmpdir(), 'sforge-firebase-root-')),
    config,
    targetName: 'prod',
    target: config.targets.prod!,
    outputs: { project: PROJECT, site_id: SITE, url: `https://${SITE}.web.app` },
    env: { GITHUB_SHA: 'abc1234def' },
    logger: createLogger({ level: 'silent' }),
    ...overrides,
  };
}
