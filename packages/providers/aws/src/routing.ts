import { type Resolution, resolveRequest } from '@staticforge/server';

export type TrailingSlash = 'always' | 'never';

/** What the CloudFront router does with a URL path, before route exceptions. */
export type RouterTarget =
  | { file: string; key?: string }
  | { redirect: string; key?: string }
  | { missing: true; key?: string };

/**
 * The rule-based part of terraform/modules/site/router.js, mirrored for
 * computing route exceptions. `key` (page-like URLs only) is the canonical
 * path under which an exception is looked up.
 */
export function routeByRule(uri: string, trailingSlash: TrailingSlash): RouterTarget {
  if (!uri.startsWith('/')) return { missing: true };
  const raw = uri.slice(1).split('/');
  const trailing = raw.at(-1) === '';
  if (trailing) raw.pop();
  const canonical: string[] = [];
  for (const part of raw) {
    let segment: string;
    try {
      segment = decodeURIComponent(part);
    } catch {
      return { missing: true };
    }
    if (segment === '' || segment.startsWith('.') || /[\\\0]/.test(segment))
      return { missing: true };
    canonical.push(encodeURIComponent(segment));
  }
  if (raw.length === 0) return { file: 'index.html' };

  const path = raw.join('/');
  const key = `/${canonical.join('/')}${trailing ? '/' : ''}`;
  if (trailing) {
    if (trailingSlash === 'always') return { file: `${path}/index.html`, key };
    // "/style.css/" is not a page; only pages lose their slash.
    return raw.at(-1)!.includes('.') ? { missing: true, key } : { redirect: `/${path}`, key };
  }
  if (raw.at(-1)!.includes('.')) return { file: path };
  return trailingSlash === 'always'
    ? { redirect: `/${path}/`, key }
    : { file: `${path}.html`, key };
}

/** The S3 key part of a router file target (URL-decoded). */
function decodedFile(file: string): string {
  return file.split('/').map(decodeURIComponent).join('/');
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/** Value of an "r:<version>:<key>" KVS entry: f:<file>, r:<location> or 404. */
function exceptionValue(truth: Resolution): string {
  if (truth.kind === 'redirect') return `r:${truth.location}`;
  if (truth.kind === 'file' && truth.status === 200) return `f:${encodePath(truth.path)}`;
  return '404';
}

function sameOutcome(rule: RouterTarget, truth: Resolution): boolean {
  if ('redirect' in rule) return truth.kind === 'redirect' && truth.location === rule.redirect;
  if ('missing' in rule) return truth.kind !== 'file' || truth.status === 404;
  if (truth.kind === 'file' && truth.status === 200) return decodedFile(rule.file) === truth.path;
  // The rule names a file that does not exist: S3 answers 404, like the local server.
  return truth.kind !== 'redirect';
}

/** Longest KVS key is 512 bytes. */
const MAX_KEY_BYTES = 512;

export interface RouteExceptions {
  /** KVS key (without the "r:<version>:" prefix) → value. */
  entries: Record<string, string>;
  /** Page URLs whose exception key would be too long for the KVS. */
  skipped: string[];
}

/**
 * The URLs of a build that the router's rules would serve differently from
 * `sforge preview` (resolveRequest), such as section pages with trailingSlash
 * "never" or files without an extension. `sforge deploy` stores them in the
 * KVS so CloudFront matches the local server.
 */
export function routeExceptions(
  files: Iterable<string>,
  trailingSlash: TrailingSlash,
  versionId: string,
): RouteExceptions {
  const set = new Set(files);
  const exists = (path: string) => set.has(path);
  const candidates = new Set<string>();
  for (const file of set) {
    const encoded = `/${encodePath(file)}`;
    if (file.endsWith('/index.html')) {
      const dir = encoded.slice(0, -'index.html'.length);
      candidates.add(dir).add(dir.slice(0, -1));
    } else if (file.endsWith('.html')) {
      const page = encoded.slice(0, -'.html'.length);
      candidates.add(page).add(`${page}/`);
    } else if (!file.split('/').at(-1)!.includes('.')) {
      candidates.add(encoded).add(`${encoded}/`);
    }
  }

  const entries: Record<string, string> = {};
  const skipped: string[] = [];
  for (const url of [...candidates].sort()) {
    const rule = routeByRule(url, trailingSlash);
    if (rule.key === undefined) continue;
    const truth = resolveRequest(url, exists, { trailingSlash });
    if (sameOutcome(rule, truth)) continue;
    if (Buffer.byteLength(`r:${versionId}:${rule.key}`) > MAX_KEY_BYTES) {
      skipped.push(url);
      continue;
    }
    entries[rule.key] = exceptionValue(truth);
  }
  return { entries, skipped };
}
