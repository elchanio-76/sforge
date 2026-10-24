import type { Element } from 'hast';
import { describe, expect, it } from 'vitest';
import type { Diagnostic } from '@staticforge/core';
import { createRefResolver, resolveOutDir, routeFor } from '../src/index.js';

describe('routeFor', () => {
  const clean = { cleanUrls: true, trailingSlash: 'always' } as const;

  it.each([
    ['index.md', '/', 'index.html'],
    ['about.md', '/about/', 'about/index.html'],
    ['blog/index.md', '/blog/', 'blog/index.html'],
    ['blog/_index.md', '/blog/', 'blog/index.html'],
    ['blog/hello.md', '/blog/hello/', 'blog/hello/index.html'],
    ['404.md', '/404.html', '404.html'],
    ['docs/404.md', '/docs/404/', 'docs/404/index.html'],
    ['café.md', '/caf%C3%A9/', 'café/index.html'],
  ])('maps %s → %s', (path, url, output) => {
    expect(routeFor(path, undefined, clean)).toEqual({ url, output });
  });

  it('applies slugs to pages but not section indexes', () => {
    expect(routeFor('blog/2026-10-hello.md', 'hello', clean).url).toBe('/blog/hello/');
    expect(routeFor('blog/index.md', 'ignored', clean).url).toBe('/blog/');
  });

  it('supports trailingSlash: never and cleanUrls: false', () => {
    expect(routeFor('about.md', undefined, { cleanUrls: true, trailingSlash: 'never' })).toEqual({
      url: '/about',
      output: 'about.html',
    });
    expect(routeFor('about.md', undefined, { cleanUrls: false, trailingSlash: 'always' })).toEqual({
      url: '/about.html',
      output: 'about.html',
    });
    expect(
      routeFor('blog/index.md', undefined, { cleanUrls: false, trailingSlash: 'always' }).url,
    ).toBe('/blog/');
  });
});

describe('createRefResolver', () => {
  const diagnostics: Diagnostic[] = [];
  const node = { type: 'element', tagName: 'a', properties: {}, children: [] } as Element;
  const resolve = createRefResolver({
    sourcePath: 'content/blog/post.md',
    pageUrls: new Map([
      ['content/blog/other.md', '/blog/other/'],
      ['content/about.md', '/about/'],
    ]),
    report: (d) => diagnostics.push({ ...d, file: 'content/blog/post.md' }),
  });

  it.each([
    ['other.md', '/blog/other/'],
    ['other.md#part', '/blog/other/#part'],
    ['../about.md?x=1', '/about/?x=1'],
    ['/about.md', '/about/'],
    ['photo.jpg', '/blog/photo.jpg'],
    ['./img/a b.png', '/blog/img/a%20b.png'],
    ['../../assets/logo.svg', '/assets/logo.svg'],
    ['../../static/cv.pdf', '/cv.pdf'],
  ])('resolves %s → %s', (ref, expected) => {
    expect(resolve(ref, node)).toBe(expected);
  });

  it.each([
    'https://x.test/a.md',
    'mailto:a@b.c',
    '#top',
    '//cdn.test/x.js',
    '/assets/site.css',
    '',
  ])('leaves %s unchanged', (ref) => {
    expect(resolve(ref, node)).toBeUndefined();
  });

  it('reports links to missing pages and outside the site', () => {
    diagnostics.length = 0;
    expect(resolve('missing.md', node)).toBeUndefined();
    expect(resolve('../../README.md', node)).toBeUndefined();
    expect(diagnostics.map((d) => d.ruleId)).toEqual(['link-broken', 'link-outside-site']);
  });
});

describe('resolveOutDir', () => {
  const root = '/projects/site';

  it('accepts directories inside the project', () => {
    expect(resolveOutDir(root, 'dist')).toBe('/projects/site/dist');
    expect(resolveOutDir(root, 'build/out')).toBe('/projects/site/build/out');
  });

  it.each(['.', '..', '/tmp/out', 'content', 'content/out', 'static', 'node_modules/x', '.git'])(
    'refuses %s',
    (outDir) => {
      expect(() => resolveOutDir(root, outDir)).toThrow(
        expect.objectContaining({ code: 'SF_UNSAFE_PATH' }),
      );
    },
  );
});
