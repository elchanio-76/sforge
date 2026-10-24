import { describe, expect, it } from 'vitest';
import { resolveRequest } from '../src/index.js';

const files = new Set([
  'index.html',
  'about/index.html',
  'blog.html',
  'style.css',
  'café/index.html',
  'a b.txt',
  '404.html',
  '.sforge/build-manifest.json',
]);
const exists = (path: string) => files.has(path);

describe('resolveRequest (trailingSlash: always)', () => {
  const resolve = (path: string) => resolveRequest(path, exists, { trailingSlash: 'always' });

  it.each([
    ['/', 'index.html'],
    ['/about/', 'about/index.html'],
    ['/style.css', 'style.css'],
    ['/blog', 'blog.html'],
    ['/caf%C3%A9/', 'café/index.html'],
    ['/a%20b.txt', 'a b.txt'],
  ])('serves %s from %s', (path, file) => {
    expect(resolve(path)).toEqual({ kind: 'file', path: file, status: 200 });
  });

  it('redirects directory URLs without a trailing slash', () => {
    expect(resolve('/about')).toEqual({ kind: 'redirect', location: '/about/' });
    expect(resolve('/caf%C3%A9')).toEqual({ kind: 'redirect', location: '/caf%C3%A9/' });
  });

  it.each([
    '/missing',
    '/missing/',
    '/.sforge/build-manifest.json',
    '/about/../style.css',
    '/%2e%2e/etc/passwd',
    '/a//b',
    '/%E0%A4%A',
    '/a%5Cb',
  ])('answers %s with the 404 page', (path) => {
    expect(resolve(path)).toEqual({ kind: 'file', path: '404.html', status: 404 });
  });

  it('reports not-found when the site has no 404 page', () => {
    expect(resolveRequest('/missing', () => false, { trailingSlash: 'always' })).toEqual({
      kind: 'not-found',
    });
  });
});

describe('resolveRequest (trailingSlash: never)', () => {
  it('serves page.html for /page and redirects /page/ to it', () => {
    const resolve = (path: string) => resolveRequest(path, exists, { trailingSlash: 'never' });
    expect(resolve('/blog')).toEqual({ kind: 'file', path: 'blog.html', status: 200 });
    expect(resolve('/blog/')).toEqual({ kind: 'redirect', location: '/blog' });
  });
});
