import type { SforgeConfig } from '@staticforge/core';

/** Security headers in a provider-neutral form; null means "do not send". */
export interface SecurityHeaders {
  contentSecurityPolicy: string | null;
  /** The search page's policy: Pagefind compiles WebAssembly. */
  searchContentSecurityPolicy: string | null;
  hsts: { maxAge: number; includeSubDomains: boolean; preload: boolean } | null;
  referrerPolicy: string;
  frameOptions: 'DENY' | 'SAMEORIGIN' | null;
  permissionsPolicy: string | null;
}

/** Add 'wasm-unsafe-eval' to script-src (or default-src when there is none). */
export function allowWasm(csp: string): string {
  const directives = csp
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean);
  const index =
    directives.findIndex((d) => /^script-src(\s|$)/i.test(d)) >= 0
      ? directives.findIndex((d) => /^script-src(\s|$)/i.test(d))
      : directives.findIndex((d) => /^default-src(\s|$)/i.test(d));
  if (index === -1) return csp;
  if (!directives[index]!.includes("'wasm-unsafe-eval'")) {
    directives[index] = `${directives[index]} 'wasm-unsafe-eval'`;
  }
  return directives.join('; ');
}

export function securityHeaders(config: SforgeConfig): SecurityHeaders {
  const { security } = config;
  const csp = security.contentSecurityPolicy === false ? null : security.contentSecurityPolicy;
  return {
    contentSecurityPolicy: csp,
    searchContentSecurityPolicy: csp === null ? null : allowWasm(csp),
    hsts: security.hsts === false ? null : security.hsts,
    referrerPolicy: security.referrerPolicy,
    frameOptions: security.frameOptions === false ? null : security.frameOptions,
    permissionsPolicy: security.permissionsPolicy === false ? null : security.permissionsPolicy,
  };
}

/**
 * Path patterns that get {@link SecurityHeaders.searchContentSecurityPolicy}:
 * the search page, and Pagefind's files, because its Web Worker compiles the
 * WebAssembly and a worker follows the CSP of its own script's response.
 */
export function searchPaths(config: SforgeConfig): string[] {
  if (!config.search.enabled) return [];
  // The page's URL (routeFor('search.md')), plus its file name where that serves it too.
  const page = !config.build.cleanUrls
    ? ['/search.html']
    : config.build.trailingSlash === 'never'
      ? ['/search', '/search.html']
      : ['/search/*'];
  return [...page, '/pagefind/*'];
}
