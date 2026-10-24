import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ErrorCode, type Logger, SforgeError } from '@staticforge/core';
import { extractFromTarGz } from './tar.js';

/** The OpenTofu release sforge downloads when no suitable `tofu` is on PATH. */
export const PINNED_TOFU_VERSION = '1.13.1';

/**
 * SHA-256 of the pinned release archives, from the release's SHA256SUMS. They
 * are embedded so a tampered download (or SHA256SUMS) is detected.
 */
const PINNED_SHA256: Record<string, string> = {
  linux_amd64: '378ada19d4bc70c43732004e8159be771b23b9a5afdf059e5f8a2b3fa2c70a69',
  linux_arm64: '9c1ef375aa1852db0b2888aa921b640c71f8140d4682aa4fec99378a64fa7dc3',
  darwin_amd64: 'a73720443ba38712d7d96dc1e857add02c15a790919c653ad07492e9952f8c27',
  darwin_arm64: 'be78f659f04ef06a9dbd9b3934d46af95d787a3aa38396d459dea395261816a9',
  windows_amd64: '6825ae311e9a15747ce2ede7b7e97c8bb744a4d271fa8113259eeeee3d09438c',
  windows_arm64: 'cc189b6f7ecba6c80924ddff72b4d086d5f727a0c31180421cfb821a3e5c7587',
  freebsd_amd64: '80fcf4dc6987ef657a490a2bef7c305c1b6b4607ae1d397c574328439ffefa23',
};

const RELEASES = 'https://github.com/opentofu/opentofu/releases/download';

export type Fetch = (url: string) => Promise<Response>;

/** OpenTofu's name for a Node platform/arch pair, e.g. "linux_amd64". */
export function tofuPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const os = { linux: 'linux', darwin: 'darwin', win32: 'windows', freebsd: 'freebsd' }[
    platform as string
  ];
  const cpu = { x64: 'amd64', arm64: 'arm64' }[arch];
  if (os === undefined || cpu === undefined) {
    throw new SforgeError(
      ErrorCode.EngineMissing,
      `OpenTofu has no release for ${platform}/${arch}`,
      { hint: 'Install tofu or terraform yourself and put it on PATH.' },
    );
  }
  return `${os}_${cpu}`;
}

export interface DownloadTofuOptions {
  version: string;
  /** Directory the binary is installed into (`<cache>/bin/tofu-<version>/`). */
  installDir: string;
  logger: Logger;
  fetch?: Fetch;
  platform?: NodeJS.Platform;
  arch?: string;
}

async function get(fetchImpl: Fetch, url: string): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    throw new SforgeError(ErrorCode.EngineMissing, `Could not download ${url}`, {
      cause: error,
      hint: 'Check the network connection, or install tofu/terraform yourself and put it on PATH.',
    });
  }
  if (!response.ok) {
    throw new SforgeError(
      ErrorCode.EngineMissing,
      `Could not download ${url}: HTTP ${response.status}`,
      { hint: 'Check iac.version, or install tofu/terraform yourself and put it on PATH.' },
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

/** The expected SHA-256 of an archive: embedded for the pin, else from SHA256SUMS. */
async function expectedSha256(
  fetchImpl: Fetch,
  version: string,
  platform: string,
  file: string,
): Promise<string> {
  if (version === PINNED_TOFU_VERSION) {
    const sha = PINNED_SHA256[platform];
    if (sha !== undefined) return sha;
  }
  const sums = (
    await get(fetchImpl, `${RELEASES}/v${version}/tofu_${version}_SHA256SUMS`)
  ).toString('utf8');
  for (const line of sums.split('\n')) {
    const [sha, name] = line.trim().split(/\s+/);
    if (name === file && sha !== undefined) return sha.toLowerCase();
  }
  throw new SforgeError(ErrorCode.EngineMissing, `${file} is not listed in the release checksums`);
}

/**
 * Download an OpenTofu release, verify its SHA-256 and install the binary
 * atomically (a concurrent run either sees the complete binary or none).
 *
 * @returns Absolute path of the installed binary.
 */
export async function downloadTofu(options: DownloadTofuOptions): Promise<string> {
  const fetchImpl = options.fetch ?? fetch;
  const platform = tofuPlatform(options.platform, options.arch);
  const exe = platform.startsWith('windows') ? 'tofu.exe' : 'tofu';
  const target = join(options.installDir, exe);
  if (existsSync(target)) return target;

  const file = `tofu_${options.version}_${platform}.tar.gz`;
  options.logger.info(`Downloading OpenTofu ${options.version} (${platform})`);
  const [archive, expected] = await Promise.all([
    get(fetchImpl, `${RELEASES}/v${options.version}/${file}`),
    expectedSha256(fetchImpl, options.version, platform, file),
  ]);
  const actual = createHash('sha256').update(archive).digest('hex');
  if (actual !== expected) {
    throw new SforgeError(ErrorCode.EngineMissing, `Checksum mismatch for ${file}`, {
      details: { expected, actual },
      hint: 'The download was corrupted or tampered with. Try again, or install tofu yourself.',
    });
  }
  const binary = extractFromTarGz(archive, exe);
  if (binary === undefined) {
    throw new SforgeError(ErrorCode.EngineMissing, `${file} does not contain ${exe}`);
  }

  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, binary, { mode: 0o755 });
    chmodSync(temp, 0o755);
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
  options.logger.info(`Installed OpenTofu ${options.version} at ${target}`);
  return target;
}
