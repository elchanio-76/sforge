import { dirname } from 'node:path';
import type { AzureAuthConfig, SforgeConfig } from '@staticforge/core';
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
  headers?: Record<string, string>;
  allowedRoles?: string[];
  statusCode?: number;
}

/** The custom role invited users get; Free plans allow 25 users with custom roles. */
export const MEMBER_ROLE = 'member';
/** Static Web Apps' preconfigured sign-in providers. */
const PROVIDERS = ['aad', 'github'] as const;

/** Shown (as a 403) to visitors who signed in but were not invited; added by the deployer. */
export const DENIED_PAGE = '_sforge/denied.html';

/** A small accessible page that lets a visitor switch accounts. */
export function deniedPage(config: SforgeConfig): string {
  const escape = (text: string) =>
    text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const title = escape(config.site.title);
  return [
    '<!doctype html>',
    `<html lang="${escape(config.site.language)}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex">',
    `<title>No access to ${title}</title>`,
    '</head>',
    '<body>',
    '<main>',
    `<h1>No access to ${title}</h1>`,
    '<p>You are signed in, but this account has not been invited to the site. ' +
      'Ask the owner for an invitation, or sign in with another account.</p>',
    '<p><a href="/.auth/logout?post_logout_redirect_uri=/">Sign out</a></p>',
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
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
  auth?: AzureAuthConfig,
): GeneratedSwaConfig {
  const security = securityHeaders(config);
  const globalHeaders: Record<string, string> = {
    'Cache-Control': cacheControl('revalidate', auth !== undefined),
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

  // Static Web Apps applies only the first route that matches a request, so on a
  // private site every route carries the role, or it would let visitors through.
  const roles = auth === undefined ? {} : { allowedRoles: [MEMBER_ROLE] };
  const routes: Route[] =
    auth === undefined
      ? []
      : [
          ...PROVIDERS.filter((p) => !auth.providers.includes(p)).map((p) => ({
            route: `/.auth/login/${p}`,
            statusCode: 404,
          })),
          { route: `/${DENIED_PAGE}`, allowedRoles: ['authenticated'] },
        ];
  if (
    security.searchContentSecurityPolicy !== null &&
    security.searchContentSecurityPolicy !== security.contentSecurityPolicy
  ) {
    const headers = { 'Content-Security-Policy': security.searchContentSecurityPolicy };
    for (const pattern of searchPaths(config)) {
      // `/x/*` does not match `/x`, which the search page is served at. Static Web Apps
      // treats `/x` and `/x/` as the same route and rejects a configuration with both.
      if (pattern.endsWith('/*')) routes.push({ route: pattern.slice(0, -2), headers, ...roles });
      routes.push({ route: pattern, headers, ...roles });
    }
  }

  const base: Record<string, unknown> = {
    // SWA's "always" also appends a slash to files (style.css → style.css/); "auto" adds it to
    // folders only, which is what build.trailingSlash "always" means.
    ...(config.build.cleanUrls && {
      trailingSlash: config.build.trailingSlash === 'always' ? 'auto' : 'never',
    }),
    ...((manifest.files['404.html'] !== undefined || auth !== undefined) && {
      responseOverrides: {
        // Visitors who have not signed in go to the first provider, then back.
        ...(auth !== undefined && {
          '401': {
            redirect: `/.auth/login/${auth.providers[0]}?post_login_redirect_uri=.referrer`,
            statusCode: 302,
          },
          '403': { rewrite: `/${DENIED_PAGE}`, statusCode: 403 },
        }),
        ...(manifest.files['404.html'] !== undefined && {
          '404': { rewrite: '/404.html', statusCode: 404 },
        }),
      },
    }),
    globalHeaders,
    ...(Object.keys(mimeTypes(manifest)).length > 0 && { mimeTypes: mimeTypes(manifest) }),
  };

  const immutable = immutableRoutes(manifest);
  const immutableHeaders = { 'Cache-Control': cacheControl('immutable') };
  const wanted: Route[] = [
    ...immutable.dirs.map((dir) => ({ route: `/${dir}/*`, headers: immutableHeaders, ...roles })),
    ...immutable.files.map((path) => ({ route: `/${path}`, headers: immutableHeaders, ...roles })),
  ];
  // Last: everything else needs the role too.
  const final: Route[] = auth === undefined ? [] : [{ route: '/*', ...roles }];

  const render = (extra: Route[], space?: number) =>
    JSON.stringify({ ...base, routes: [...routes, ...extra, ...final] }, null, space);

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
