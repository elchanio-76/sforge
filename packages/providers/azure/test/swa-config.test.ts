import { describe, expect, it } from 'vitest';
import { validateConfig } from '@staticforge/core';
import type { BuildManifest } from '@staticforge/provider-api';
import { SWA_CONFIG_LIMIT, generateStaticWebAppConfig } from '../src/index.js';

function manifest(files: Record<string, 'immutable' | 'revalidate'>): BuildManifest {
  return {
    version: 1,
    files: Object.fromEntries(
      Object.entries(files).map(([path, cache]) => [path, { sha256: 'x', size: 10, cache }]),
    ),
  };
}

const config = (build: Record<string, unknown> = {}, security: Record<string, unknown> = {}) =>
  validateConfig({
    site: { title: 'Docs', baseUrl: 'https://docs.example.com' },
    build,
    security,
  });

const routes = (c: Record<string, unknown>) =>
  c.routes as { route: string; headers: Record<string, string> }[];

describe('generated staticwebapp.config.json', () => {
  it('sends the security headers on every response', () => {
    const { config: c } = generateStaticWebAppConfig(
      config(),
      manifest({ 'index.html': 'revalidate' }),
    );
    const headers = c.globalHeaders as Record<string, string>;
    expect(headers['Content-Security-Policy']).toContain("default-src 'self'");
    expect(headers['Strict-Transport-Security']).toMatch(/^max-age=\d+/);
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('SAMEORIGIN');
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['Permissions-Policy']).toContain('camera=()');
    expect(headers['Cache-Control']).toBe('public, max-age=0, must-revalidate');
  });

  it('omits headers that are switched off', () => {
    const { config: c } = generateStaticWebAppConfig(
      config({}, { contentSecurityPolicy: false, hsts: false, frameOptions: false }),
      manifest({ 'index.html': 'revalidate' }),
    );
    const headers = c.globalHeaders as Record<string, string>;
    expect(headers).not.toHaveProperty('Content-Security-Policy');
    expect(headers).not.toHaveProperty('Strict-Transport-Security');
    expect(headers).not.toHaveProperty('X-Frame-Options');
    expect(c.routes).toEqual([]);
  });

  it('follows the trailing-slash policy, and leaves it out without clean URLs', () => {
    const m = manifest({ 'index.html': 'revalidate' });
    expect(
      generateStaticWebAppConfig(config({ trailingSlash: 'never' }), m).config.trailingSlash,
    ).toBe('never');
    // "always" in SWA would also redirect style.css to style.css/.
    expect(generateStaticWebAppConfig(config(), m).config.trailingSlash).toBe('auto');
    expect(generateStaticWebAppConfig(config({ cleanUrls: false }), m).config).not.toHaveProperty(
      'trailingSlash',
    );
  });

  it('serves 404.html with status 404 when the site has one', () => {
    const withPage = generateStaticWebAppConfig(config(), manifest({ '404.html': 'revalidate' }));
    expect(withPage.config.responseOverrides).toEqual({
      '404': { rewrite: '/404.html', statusCode: 404 },
    });
    const without = generateStaticWebAppConfig(config(), manifest({ 'index.html': 'revalidate' }));
    expect(without.config).not.toHaveProperty('responseOverrides');
  });

  it('gives the search page and Pagefind files the WebAssembly CSP', () => {
    const { config: c } = generateStaticWebAppConfig(
      config(),
      manifest({ 'index.html': 'revalidate' }),
    );
    const searchRoutes = routes(c).map((r) => r.route);
    expect(searchRoutes).toEqual(['/search', '/search/*', '/pagefind', '/pagefind/*']);
    // Static Web Apps rejects two rules that differ only by a trailing slash.
    expect(new Set(searchRoutes.map((r) => r.replace(/\/$/, ''))).size).toBe(searchRoutes.length);
    for (const r of routes(c)) {
      expect(r.headers['Content-Security-Policy']).toContain("'wasm-unsafe-eval'");
    }
  });

  it('does not add search routes when search is off', () => {
    const { config: c } = generateStaticWebAppConfig(
      validateConfig({
        site: { title: 'Docs', baseUrl: 'https://docs.example.com' },
        search: { enabled: false },
      }),
      manifest({ 'index.html': 'revalidate' }),
    );
    expect(c.routes).toEqual([]);
  });

  it('caches fingerprinted files for a year: directories as one rule, others one by one', () => {
    const { config: c } = generateStaticWebAppConfig(
      config(),
      manifest({
        'index.html': 'revalidate',
        '_assets/img/a-1-480.webp': 'immutable',
        '_assets/img/a-1-960.webp': 'immutable',
        'assets/css/site.71b4.css': 'immutable',
        'assets/css/other.css': 'revalidate',
        'assets/js/site.9c1.js': 'immutable',
      }),
    );
    const cached = routes(c).filter((r) => r.headers['Cache-Control']?.includes('immutable'));
    // The shallowest directory that holds nothing but fingerprinted files becomes one rule.
    expect(cached.map((r) => r.route)).toEqual([
      '/_assets/*',
      '/assets/js/*',
      '/assets/css/site.71b4.css',
    ]);
  });

  it('declares types Static Web Apps may not know, only for files that exist', () => {
    const { config: c } = generateStaticWebAppConfig(
      config(),
      manifest({ 'a.avif': 'revalidate', 'b.vtt': 'revalidate', 'index.html': 'revalidate' }),
    );
    expect(c.mimeTypes).toEqual({ '.avif': 'image/avif', '.vtt': 'text/vtt' });
  });

  it('stays below the 20 KB limit by dropping per-file cache rules', () => {
    const files: Record<string, 'immutable' | 'revalidate'> = {
      'index.html': 'revalidate',
      'assets/keep.css': 'revalidate',
    };
    for (let i = 0; i < 2000; i++)
      files[`assets/file-${i}.${String(i).padStart(8, 'a')}.js`] = 'immutable';
    const generated = generateStaticWebAppConfig(config(), manifest(files));
    expect(generated.json.length).toBeLessThan(SWA_CONFIG_LIMIT);
    expect(generated.droppedRoutes).toBeGreaterThan(0);
    // The security headers survive.
    expect(generated.config.globalHeaders).toHaveProperty('Content-Security-Policy');
  });

  it('is valid JSON ending in a newline', () => {
    const { json } = generateStaticWebAppConfig(config(), manifest({ 'index.html': 'revalidate' }));
    expect(() => JSON.parse(json)).not.toThrow();
    expect(json.endsWith('\n')).toBe(true);
  });
});
