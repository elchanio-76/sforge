import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ErrorCode, type Logger, SforgeError } from '@staticforge/core';
import { cacheRoot } from '@staticforge/iac';

/** Microsoft's release metadata for the deployment client (what the `swa` CLI reads). */
const METADATA_URL = 'https://aka.ms/swalocaldeploy';

export const PINNED_CLIENT_BUILD = '134664351bac2104cb9ec773226e5b3fc265675d';

const CDN = `https://swalocaldeployv2-bndtgugjgqc3dhdx.b01.azurefd.net/downloads/${PINNED_CLIENT_BUILD}`;

/**
 * The pinned StaticSitesClient build, per platform: where to get it and its
 * SHA-256, embedded so a tampered download or tampered metadata is detected.
 * Microsoft ships x64 builds only.
 */
const PINNED: Record<string, { url: string; sha: string; file: string }> = {
  'linux-x64': {
    url: `${CDN}/linux/StaticSitesClient`,
    sha: '638cde5d1a249355e72c891a372953a84d09f897fa47691d81bc45ca8fc615b9',
    file: 'StaticSitesClient',
  },
  'osx-x64': {
    url: `${CDN}/macOS/StaticSitesClient`,
    sha: '03387f4f8d5b04b4e20214499c0c884ec138e3bd6adc4fbd0e5ff27da54b3227',
    file: 'StaticSitesClient',
  },
  'win-x64': {
    url: `${CDN}/windows/StaticSitesClient.exe`,
    sha: 'c6e7332c35549990330299aaacd85e911d6770ea4b253b9da64a6ca8d9e3f02b',
    file: 'StaticSitesClient.exe',
  },
};

export type Fetch = (url: string) => Promise<Response>;

/** Microsoft's name for a Node platform; `undefined` where there is no build. */
export function clientPlatform(platform: NodeJS.Platform = process.platform): string | undefined {
  switch (platform) {
    case 'win32':
      return 'win-x64';
    case 'darwin':
      return 'osx-x64';
    case 'linux':
    case 'freebsd':
    case 'openbsd':
    case 'sunos':
    case 'aix':
      return 'linux-x64';
    default:
      return undefined;
  }
}

export interface EnsureClientOptions {
  logger: Logger;
  env?: NodeJS.ProcessEnv;
  fetch?: Fetch;
  platform?: NodeJS.Platform;
}

interface Source {
  url: string;
  sha: string;
  file: string;
  build: string;
}

function failure(message: string, cause?: unknown): SforgeError {
  return new SforgeError(ErrorCode.DeployFailed, message, {
    ...(cause !== undefined && { cause }),
    hint: 'The deployment client is downloaded on first use: check that you have network access to Microsoft’s download host.',
  });
}

async function fetchBytes(fetchImpl: Fetch, url: string): Promise<Buffer | number> {
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    throw failure(`Could not download ${url}`, error);
  }
  if (!response.ok) return response.status;
  return Buffer.from(await response.arrayBuffer());
}

/**
 * The newest "stable" build from Microsoft's metadata. Only a fallback for when
 * the pinned build has been withdrawn: its checksum then comes from the same
 * host as the file.
 */
async function stableSource(fetchImpl: Fetch, platform: string): Promise<Source> {
  const body = await fetchBytes(fetchImpl, METADATA_URL);
  if (typeof body === 'number') {
    throw failure(`Could not read the deployment client metadata: HTTP ${body}`);
  }
  const entries = JSON.parse(body.toString('utf8')) as unknown;
  const stable = Array.isArray(entries)
    ? (entries.find((e) => (e as { version?: unknown }).version === 'stable') as
        | {
            buildId?: string;
            files?: Record<string, { url?: string; sha?: string } | undefined>;
          }
        | undefined)
    : undefined;
  const file = stable?.files?.[platform];
  if (stable?.buildId === undefined || file?.url === undefined || file.sha === undefined) {
    throw failure(`The deployment client metadata has no ${platform} build`);
  }
  return {
    url: file.url,
    sha: file.sha.toLowerCase(),
    file: PINNED[platform]?.file ?? 'StaticSitesClient',
    build: stable.buildId,
  };
}

async function install(fetchImpl: Fetch, source: Source, target: string): Promise<'ok' | number> {
  const bytes = await fetchBytes(fetchImpl, source.url);
  if (typeof bytes === 'number') return bytes;
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== source.sha) {
    throw new SforgeError(
      ErrorCode.DeployFailed,
      `Checksum mismatch for the deployment client ${source.build}`,
      {
        details: { expected: source.sha, actual },
        hint: 'The download was corrupted or tampered with. Try again.',
      },
    );
  }
  mkdirSync(dirname(target), { recursive: true });
  // Atomic: a concurrent run sees the complete binary or none.
  const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, bytes, { mode: 0o755 });
    chmodSync(temp, 0o755);
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
  return 'ok';
}

/**
 * Path of Microsoft's StaticSitesClient, downloaded on first use into
 * `<cache>/bin/staticsitesclient-<build>/` and verified against a SHA-256 that is
 * embedded in sforge. Replaces the `swa` CLI, which pulled in a large
 * dependency tree for this one download.
 */
export async function ensureClient(options: EnsureClientOptions): Promise<string> {
  const fetchImpl = options.fetch ?? fetch;
  const platform = clientPlatform(options.platform);
  const pinned = platform === undefined ? undefined : PINNED[platform];
  if (platform === undefined || pinned === undefined) {
    throw new SforgeError(
      ErrorCode.DeployFailed,
      `The Static Web Apps deployment client has no build for ${options.platform ?? process.platform}`,
      {
        hint: 'Deploy from Linux, macOS or Windows (x64), for example from a GitHub Actions runner.',
      },
    );
  }
  const bin = (build: string) =>
    join(cacheRoot(options.env), 'bin', `staticsitesclient-${build}`, pinned.file);

  const target = bin(PINNED_CLIENT_BUILD);
  if (existsSync(target)) return target;

  options.logger.info(`Downloading the Static Web Apps deployment client (${platform})`);
  const first = await install(fetchImpl, { ...pinned, build: PINNED_CLIENT_BUILD }, target);
  if (first === 'ok') return target;

  options.logger.warn(
    `The pinned deployment client is gone (HTTP ${first}); using Microsoft's current stable build`,
  );
  const stable = await stableSource(fetchImpl, platform);
  const fallback = bin(stable.build);
  if (existsSync(fallback)) return fallback;
  const second = await install(fetchImpl, stable, fallback);
  if (second !== 'ok') throw failure(`Could not download ${stable.url}: HTTP ${second}`);
  return fallback;
}
