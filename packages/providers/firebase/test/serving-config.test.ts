import { describe, expect, it } from 'vitest';
import { validateConfig } from '@staticforge/core';
import type { BuildManifest } from '@staticforge/provider-api';
import { MAX_HEADER_RULES, generateServingConfig } from '../src/index.js';

function config(overrides: Record<string, unknown> = {}) {
  return validateConfig({
    site: { title: 'Docs', baseUrl: 'https://docs.example.com' },
    ...overrides,
  });
}

function manifest(files: Record<string, 'immutable' | 'revalidate'>): BuildManifest {
  return {
    version: 1,
    files: Object.fromEntries(
      Object.entries(files).map(([path, cache]) => [path, { size: 1, sha256: 'x', cache }]),
    ) as BuildManifest['files'],
  };
}

const PLAIN = manifest({ 'index.html': 'revalidate' });

describe('generateServingConfig', () => {
  it('sends the security headers and revalidation on every response', () => {
    const [all] = generateServingConfig(config(), PLAIN).config.headers;
    expect(all?.glob).toBe('**');
    expect(all?.headers).toMatchObject({
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'SAMEORIGIN',
      'Strict-Transport-Security': 'max-age=63072000',
    });
    expect(all?.headers['Content-Security-Policy']).toContain("default-src 'self'");
    expect(all?.headers['Permissions-Policy']).toContain('camera=()');
  });

  it('leaves out the headers that are turned off', () => {
    const [all] = generateServingConfig(
      config({
        security: {
          contentSecurityPolicy: false,
          hsts: false,
          frameOptions: false,
          permissionsPolicy: false,
        },
      }),
      PLAIN,
    ).config.headers;
    expect(Object.keys(all!.headers).sort()).toEqual([
      'Cache-Control',
      'Referrer-Policy',
      'X-Content-Type-Options',
    ]);
  });

  it('allows WebAssembly on the search page and its worker only', () => {
    const { headers } = generateServingConfig(config(), PLAIN).config;
    const search = headers.filter((h) => h.regex !== undefined);
    expect(search.map((h) => h.regex)).toEqual(['^/search(?:/.*)?$', '^/pagefind(?:/.*)?$']);
    for (const rule of search) {
      expect(rule.headers['Content-Security-Policy']).toContain("'wasm-unsafe-eval'");
    }
    expect(headers[0]?.headers['Content-Security-Policy']).not.toContain('wasm-unsafe-eval');
  });

  it('adds no search rules when search is off', () => {
    const { headers } = generateServingConfig(config({ search: { enabled: false } }), PLAIN).config;
    expect(headers).toHaveLength(1);
  });

  it('follows the search page where clean URLs put it', () => {
    const regexes = (build: Record<string, unknown>) =>
      generateServingConfig(config({ build }), PLAIN)
        .config.headers.map((h) => h.regex)
        .filter(Boolean);
    expect(regexes({ trailingSlash: 'never' })[0]).toBe('^/search$');
    expect(regexes({ cleanUrls: false })[0]).toBe('^/search\\.html$');
  });

  it('caches fingerprinted files for a year, after the rule that covers everything', () => {
    const { headers } = generateServingConfig(
      config(),
      manifest({
        'index.html': 'revalidate',
        'assets/img/a.123.avif': 'immutable',
        'assets/img/b.456.avif': 'immutable',
        'assets/app.789.css': 'immutable',
        'assets/site.css': 'revalidate',
      }),
    ).config;
    const cached = headers.filter((h) => h.headers['Cache-Control']?.includes('immutable'));
    expect(cached.map((h) => h.regex)).toEqual(['^/assets/img/', '^/assets/app\\.789\\.css$']);
    // Later rules win, so they must follow the one that sets revalidation everywhere.
    expect(headers.indexOf(cached[0]!)).toBeGreaterThan(0);
  });

  it('keeps regular expression characters in paths literal', () => {
    const { headers } = generateServingConfig(
      config(),
      manifest({ 'a(1)+b.123.js': 'immutable', 'index.html': 'revalidate' }),
    ).config;
    expect(headers.at(-1)?.regex).toBe('^/a\\(1\\)\\+b\\.123\\.js$');
  });

  it('stops listing files at the limit, and says how many it left out', () => {
    const files: Record<string, 'immutable' | 'revalidate'> = { 'index.html': 'revalidate' };
    for (let i = 0; i < MAX_HEADER_RULES + 5; i++) files[`f${i}.js`] = 'immutable';
    const { config: serving, droppedRules } = generateServingConfig(config(), manifest(files));
    expect(serving.headers).toHaveLength(MAX_HEADER_RULES);
    expect(droppedRules).toBeGreaterThan(5);
  });

  it('maps the URL settings of the build', () => {
    const serving = (build: Record<string, unknown>) =>
      generateServingConfig(config({ build }), PLAIN).config;
    expect(serving({})).toMatchObject({ cleanUrls: true, trailingSlashBehavior: 'ADD' });
    expect(serving({ trailingSlash: 'never' })).toMatchObject({
      cleanUrls: true,
      trailingSlashBehavior: 'REMOVE',
    });
    const plain = serving({ cleanUrls: false });
    expect(plain.cleanUrls).toBe(false);
    expect(plain.trailingSlashBehavior).toBeUndefined();
  });
});
