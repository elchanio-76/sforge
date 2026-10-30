import type { SforgeConfig } from '@staticforge/core';
import {
  type BuildManifest,
  cacheControl,
  hstsValue,
  immutableRoutes,
  searchPaths,
  securityHeaders,
} from '@staticforge/provider-api';
import type { HostingHeaderRule, ServingConfig } from './client.js';

/**
 * A version's configuration carries one rule per fingerprinted file that is not in an
 * all-immutable directory. Hosting documents no limit, so this stays well within what
 * firebase.json files are known to carry; files beyond it just revalidate.
 */
export const MAX_HEADER_RULES = 1000;

export interface GeneratedServingConfig {
  config: ServingConfig;
  /** Cache rules left out because of {@link MAX_HEADER_RULES} (those files revalidate). */
  droppedRules: number;
}

/** A literal path inside an RE2 regular expression. */
const literal = (path: string) => path.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');

/** `/x/*` also matches `/x`, which the search page is served at. */
function searchRegex(pattern: string): string {
  return pattern.endsWith('/*')
    ? `^${literal(pattern.slice(0, -2))}(?:/.*)?$`
    : `^${literal(pattern)}$`;
}

/**
 * The configuration of a version: the `security` headers on every response, the cache
 * classes of the manifest and the search page's own CSP. Hosting has no per-file metadata,
 * so cache classes become rules; a later rule overrides what an earlier one set. Regular
 * expressions rather than globs, because built paths can hold characters globs treat
 * specially. Hosting serves `404.html` by itself.
 */
export function generateServingConfig(
  config: SforgeConfig,
  manifest: BuildManifest,
): GeneratedServingConfig {
  const security = securityHeaders(config);
  const headers: HostingHeaderRule[] = [
    {
      glob: '**',
      headers: {
        // Hosting's default is an hour in the browser: a deploy must show at once.
        'Cache-Control': cacheControl('revalidate'),
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': security.referrerPolicy,
        ...(security.contentSecurityPolicy !== null && {
          'Content-Security-Policy': security.contentSecurityPolicy,
        }),
        ...(security.hsts !== null && { 'Strict-Transport-Security': hstsValue(security.hsts) }),
        ...(security.frameOptions !== null && { 'X-Frame-Options': security.frameOptions }),
        ...(security.permissionsPolicy !== null && {
          'Permissions-Policy': security.permissionsPolicy,
        }),
      },
    },
  ];
  if (
    security.searchContentSecurityPolicy !== null &&
    security.searchContentSecurityPolicy !== security.contentSecurityPolicy
  ) {
    for (const pattern of searchPaths(config)) {
      headers.push({
        regex: searchRegex(pattern),
        headers: { 'Content-Security-Policy': security.searchContentSecurityPolicy },
      });
    }
  }

  const immutable = immutableRoutes(manifest);
  const cache = { 'Cache-Control': cacheControl('immutable') };
  const wanted: HostingHeaderRule[] = [
    ...immutable.dirs.map((dir) => ({ regex: `^/${literal(dir)}/`, headers: cache })),
    ...immutable.files.map((path) => ({ regex: `^/${literal(path)}$`, headers: cache })),
  ];
  const room = Math.max(0, MAX_HEADER_RULES - headers.length);
  headers.push(...wanted.slice(0, room));

  const { cleanUrls, trailingSlash } = config.build;
  return {
    config: {
      headers,
      cleanUrls,
      ...(cleanUrls && { trailingSlashBehavior: trailingSlash === 'always' ? 'ADD' : 'REMOVE' }),
    },
    droppedRules: Math.max(0, wanted.length - room),
  };
}
