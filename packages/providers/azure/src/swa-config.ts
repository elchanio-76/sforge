import { dirname } from 'node:path';
import type { SforgeConfig } from '@staticforge/core';
import {
  type BuildManifest,
  cacheControl,
  contentType,
  publishedFiles,
  searchPaths,
  securityHeaders,
} from '@staticforge/provider-api';

/** Static Web Apps rejects a configuration file larger than 20 KB. */
export const SWA_CONFIG_LIMIT = 20 * 1024;
/** Stay below the limit: the platform may count differently than JSON.stringify. */
const BUDGET = 19 * 1024;

export const SWA_CONFIG_FILE = 'staticwebapp.config.json';

interface Route {
  route: string;
  headers: Record<string, string>;
}

export interface GeneratedSwaConfig {
  config: Record<string, unknown>;
  json: string;
  /** Cache rules left out because the file would exceed the size limit (those files revalidate). */
  droppedRoutes: number;
}

/** Extensions Static Web Apps may not know, given the type `sforge preview` serves them as. */
const MIME_CANDIDATES = ['.avif', '.webp', '.vtt', '.webmanifest', '.mjs', '.wasm', '.xml'];

function mimeTypes(manifest: BuildManifest): Record<string, string> {
  const present = new Set(
    publishedFiles(manifest)
      .map(([path]) => /\.[a-z0-9]+$/i.exec(path)?.[0].toLowerCase())
      .filter((ext): ext is string => ext !== undefined),
  );
  return Object.fromEntries(
    MIME_CANDIDATES.filter((ext) => present.has(ext)).map((ext) => [
      ext,
      contentType(`x${ext}`).split(';')[0] as string,
    ]),
  );
}

/**
 * Routes that cache fingerprinted files for a year. A directory whose files are
 * all immutable (the image variants) becomes one wildcard route, anything else
 * is listed file by file, most useful first.
 */
function immutableRoutes(manifest: BuildManifest): { dirs: string[]; files: string[] } {
  const files = publishedFiles(manifest);
  const totals = new Map<string, { all: number; immutable: number }>();
  for (const [path, entry] of files) {
    for (let dir = dirname(path); dir !== '.'; dir = dirname(dir)) {
      const total = totals.get(dir) ?? { all: 0, immutable: 0 };
      total.all++;
      if (entry.cache === 'immutable') total.immutable++;
      totals.set(dir, total);
    }
  }
  const dirs = new Set<string>();
  const exact: string[] = [];
  for (const [path, entry] of files) {
    if (entry.cache !== 'immutable') continue;
    // The shallowest ancestor holding nothing but immutable files.
    const ancestors: string[] = [];
    for (let dir = dirname(path); dir !== '.'; dir = dirname(dir)) ancestors.unshift(dir);
    const whole = ancestors.find((dir) => {
      const total = totals.get(dir);
      return total !== undefined && total.all === total.immutable;
    });
    if (whole !== undefined) dirs.add(whole);
    else exact.push(path);
  }
  return { dirs: [...dirs].sort(), files: exact.sort() };
}

/** The `Strict-Transport-Security` value for the configured policy. */
function hstsValue(hsts: NonNullable<ReturnType<typeof securityHeaders>['hsts']>): string {
  return [
    `max-age=${hsts.maxAge}`,
    ...(hsts.includeSubDomains ? ['includeSubDomains'] : []),
    ...(hsts.preload ? ['preload'] : []),
  ].join('; ');
}

/**
 * The `staticwebapp.config.json` of a build: the `security` headers on every
 * response, the cache classes of the manifest, the trailing-slash policy, a 404
 * page and the search page's own CSP. Static Web Apps has no per-file metadata,
 * so cache classes become route rules, within the 20 KB limit of the file.
 */
export function generateStaticWebAppConfig(
  config: SforgeConfig,
  manifest: BuildManifest,
): GeneratedSwaConfig {
  const security = securityHeaders(config);
  const globalHeaders: Record<string, string> = {
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
  };

  const routes: Route[] = [];
  if (
    security.searchContentSecurityPolicy !== null &&
    security.searchContentSecurityPolicy !== security.contentSecurityPolicy
  ) {
    const headers = { 'Content-Security-Policy': security.searchContentSecurityPolicy };
    for (const pattern of searchPaths(config)) {
      // `/x/*` does not match `/x`, which the search page is served at. Static Web Apps
      // treats `/x` and `/x/` as the same route and rejects a configuration with both.
      if (pattern.endsWith('/*')) routes.push({ route: pattern.slice(0, -2), headers });
      routes.push({ route: pattern, headers });
    }
  }

  const base: Record<string, unknown> = {
    // SWA's "always" also appends a slash to files (style.css → style.css/); "auto" adds it to
    // folders only, which is what build.trailingSlash "always" means.
    ...(config.build.cleanUrls && {
      trailingSlash: config.build.trailingSlash === 'always' ? 'auto' : 'never',
    }),
    ...(manifest.files['404.html'] !== undefined && {
      responseOverrides: { '404': { rewrite: '/404.html', statusCode: 404 } },
    }),
    globalHeaders,
    ...(Object.keys(mimeTypes(manifest)).length > 0 && { mimeTypes: mimeTypes(manifest) }),
  };

  const immutable = immutableRoutes(manifest);
  const immutableHeaders = { 'Cache-Control': cacheControl('immutable') };
  const wanted: Route[] = [
    ...immutable.dirs.map((dir) => ({ route: `/${dir}/*`, headers: immutableHeaders })),
    ...immutable.files.map((path) => ({ route: `/${path}`, headers: immutableHeaders })),
  ];

  const render = (extra: Route[], space?: number) =>
    JSON.stringify({ ...base, routes: [...routes, ...extra] }, null, space);

  // The size only grows with the number of routes: find how many fit. Directory rules
  // come first (they cover the most files), so single files are dropped from the end.
  let low = 0;
  let high = wanted.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (render(wanted.slice(0, mid)).length <= BUDGET) low = mid;
    else high = mid - 1;
  }
  const used = wanted.slice(0, low);
  const pretty = render(used, 2);
  const json = pretty.length <= BUDGET ? pretty : render(used);
  return {
    config: JSON.parse(json) as Record<string, unknown>,
    json: `${json}\n`,
    droppedRoutes: wanted.length - low,
  };
}
