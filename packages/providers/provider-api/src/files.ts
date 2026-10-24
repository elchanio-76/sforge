import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MANIFEST_PATH, type ManifestEntry } from '@staticforge/build';
import { ErrorCode, SforgeError } from '@staticforge/core';

export { contentType } from '@staticforge/server';

export interface BuildManifest {
  version: number;
  generator?: string;
  builtAt?: string;
  baseUrl?: string;
  files: Record<string, ManifestEntry>;
}

/** Cache-Control for a manifest cache class (the same on every provider). */
export function cacheControl(cache: ManifestEntry['cache']): string {
  return cache === 'immutable'
    ? 'public, max-age=31536000, immutable'
    : 'public, max-age=0, must-revalidate';
}

/** Read `<buildDir>/.sforge/build-manifest.json`. */
export function readManifest(buildDir: string): BuildManifest {
  const path = join(buildDir, MANIFEST_PATH);
  if (!existsSync(path)) {
    throw new SforgeError(ErrorCode.NotBuilt, `No build found in ${buildDir}`, {
      hint: 'Run `sforge build` first, or deploy without --no-build.',
    });
  }
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as BuildManifest;
  if (typeof manifest.files !== 'object' || manifest.files === null) {
    throw new SforgeError(ErrorCode.NotBuilt, `${path} is not a staticforge build manifest`);
  }
  return manifest;
}

/** Whether a built file is published: dot-files and dot-directories (.sforge/) never are. */
export function isPublished(path: string): boolean {
  return path.split('/').every((segment) => segment !== '' && !segment.startsWith('.'));
}

/** Files of a build to upload, sorted, with their manifest entries. */
export function publishedFiles(manifest: BuildManifest): [string, ManifestEntry][] {
  return Object.entries(manifest.files)
    .filter(([path]) => isPublished(path))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export type FileChange = 'upload' | 'copy' | 'unchanged';

export interface FilePlan {
  path: string;
  entry: ManifestEntry;
  /**
   * `upload`: new or changed. `copy`: identical to the previous version but
   * under another prefix (copied server-side). `unchanged`: already in place.
   */
  change: FileChange;
}

export interface DeployDiff {
  files: FilePlan[];
  /** Paths in the previous manifest of the same prefix that the new build no longer has. */
  removed: string[];
}

/**
 * Compare a build with what is deployed. `samePrefix` is true when the new
 * files overwrite the previous ones in place (a PR preview redeploy) and
 * false when they go to a new version prefix.
 */
export function diffManifests(
  next: BuildManifest,
  previous: BuildManifest | undefined,
  samePrefix: boolean,
): DeployDiff {
  const before = previous?.files ?? {};
  const files = publishedFiles(next).map(([path, entry]): FilePlan => {
    const old = before[path];
    const same = old !== undefined && old.sha256 === entry.sha256 && old.cache === entry.cache;
    return { path, entry, change: same ? (samePrefix ? 'unchanged' : 'copy') : 'upload' };
  });
  const removed = samePrefix
    ? Object.keys(before).filter((path) => isPublished(path) && next.files[path] === undefined)
    : [];
  return { files, removed: removed.sort() };
}

/** Short SHA of HEAD in `dir`, or undefined outside a git checkout. */
export function gitShortSha(dir: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.GITHUB_SHA) return env.GITHUB_SHA.slice(0, 7);
  try {
    return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}

/** `<UTC timestamp>-<git sha>`, e.g. "20261024T173405Z-6ffcbe4": sortable and traceable. */
export function newVersionId(date: Date, sha: string | undefined): string {
  const stamp = date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  return `${stamp}-${sha ?? 'local'}`;
}

/** Version ids of production deploys (as created by {@link newVersionId}). */
export const VERSION_ID = /^\d{8}T\d{6}Z-[a-z0-9]{1,40}$/;

/** PR preview ids double as DNS labels: pr-42.preview.example.com. */
export const PREVIEW_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function assertPreviewId(id: string): void {
  if (!PREVIEW_ID.test(id) || VERSION_ID.test(id) || id === 'none' || id === 'active') {
    throw new SforgeError(ErrorCode.Usage, `Invalid preview id "${id}"`, {
      hint: 'Use a DNS label such as "pr-42" (lowercase letters, digits and "-").',
    });
  }
}

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
