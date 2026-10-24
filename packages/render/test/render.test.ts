import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@staticforge/core';
import { type RenderContext, createRenderer, loadTheme, themeAssetUrl } from '../src/index.js';

function tempDir(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'sforge-render-'));
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  return root;
}

function context(
  overrides: Partial<RenderContext['page']> = {},
  content = '<p>Hello</p>',
): RenderContext {
  return {
    site: {
      title: 'Site',
      description: 'A site',
      author: 'Ada',
      language: 'en',
      baseUrl: 'https://example.com',
    },
    page: {
      title: 'About',
      description: undefined,
      url: '/about/',
      absoluteUrl: 'https://example.com/about/',
      lang: 'en',
      date: undefined,
      updated: undefined,
      tags: [],
      tagLinks: [],
      layout: 'page',
      sourcePath: 'content/about.md',
      headings: [],
      data: {},
      ...overrides,
    },
    content,
    nav: [
      { title: 'About', url: '/about/', current: true, active: true },
      { title: 'Blog', url: '/blog/', current: false, active: false },
    ],
    theme: { styles: [themeAssetUrl('css/theme.css')], scripts: [] },
    data: {},
    build: { generator: 'staticforge test', time: '2026-10-24T00:00:00.000Z', year: 2026 },
    collections: {},
    tags: [],
    tagsUrl: undefined,
    breadcrumbs: [],
    feeds: [],
    search: undefined,
  };
}

describe('loadTheme', () => {
  it('loads the bundled default theme', () => {
    const theme = loadTheme('default', tempDir());
    expect(theme.manifest).toMatchObject({
      name: 'default',
      defaultLayout: 'page',
      styles: ['css/theme.css'],
    });
  });

  it('loads a theme directory relative to the project', () => {
    const root = tempDir({
      'themes/mine/theme.json': JSON.stringify({ name: 'mine', layouts: ['page'] }),
      'themes/mine/layouts/page.njk': '{{ content | safe }}',
    });
    expect(loadTheme('./themes/mine', root).manifest.name).toBe('mine');
  });

  it('reports missing theme directories and packages', () => {
    const root = tempDir();
    expect(() => loadTheme('./nope', root)).toThrow(
      expect.objectContaining({ code: ErrorCode.ThemeNotFound }),
    );
    expect(() => loadTheme('sforge-theme-nope', root)).toThrow(
      expect.objectContaining({
        code: ErrorCode.ThemeNotFound,
        hint: expect.stringContaining('npm install'),
      }),
    );
  });

  it('rejects invalid manifests and missing layout or asset files', () => {
    const invalid = tempDir({ 't/theme.json': JSON.stringify({ name: 'x', layouts: [] }) });
    expect(() => loadTheme('./t', invalid)).toThrow(
      expect.objectContaining({ code: ErrorCode.ThemeInvalid }),
    );

    const missing = tempDir({
      't/theme.json': JSON.stringify({ name: 'x', layouts: ['page'], styles: ['../escape.css'] }),
    });
    expect(() => loadTheme('./t', missing)).toThrow(
      expect.objectContaining({ code: ErrorCode.ThemeInvalid }),
    );

    const noFiles = tempDir({
      't/theme.json': JSON.stringify({ name: 'x', layouts: ['page'], styles: ['a.css'] }),
    });
    expect(() => loadTheme('./t', noFiles)).toThrow(
      /missing files: layouts\/page.njk, assets\/a.css/,
    );
  });
});

describe('createRenderer with the default theme', () => {
  const root = tempDir();
  const renderer = createRenderer(loadTheme('default', root), {
    rootDir: root,
    baseUrl: 'https://example.com',
  });

  it('renders an accessible page skeleton', () => {
    const html = renderer.render('page', context());
    expect(html).toMatch(/^<!doctype html>\n<html lang="en">/);
    expect(html).toContain('<title>About | Site</title>');
    expect(html).toContain('<meta name="description" content="A site">');
    expect(html).toContain('<link rel="canonical" href="https://example.com/about/">');
    expect(html).toContain('<link rel="stylesheet" href="/assets/theme/css/theme.css">');
    expect(html).toContain('<a class="skip-link" href="#main"');
    expect(html).toContain('<main id="main" tabindex="-1" data-testid="main">');
    expect(html).toContain('<nav class="site-nav" aria-label="Main" data-testid="site-nav">');
    expect(html).toContain('<a href="/about/" aria-current="page">About</a>');
    expect(html).toContain('<h1>About</h1>');
    expect(html).toContain('<p>Hello</p>');
    expect(html.match(/<h1/g)).toHaveLength(1);
  });

  it('uses the site title alone on the home page', () => {
    expect(renderer.render('page', context({ url: '/', title: 'Home' }))).toContain(
      '<title>Site</title>',
    );
  });

  it('escapes values but not content', () => {
    const html = renderer.render('page', context({ title: '<script>x</script>' }, '<em>ok</em>'));
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).toContain('<em>ok</em>');
  });

  it('renders post dates and tags', () => {
    const html = renderer.render(
      'post',
      context({
        layout: 'post',
        date: new Date('2026-03-05'),
        tags: ['news', 'aws'],
        tagLinks: [
          { name: 'news', slug: 'news', url: '/tags/news/' },
          { name: 'aws', slug: 'aws', url: undefined },
        ],
        lang: 'en-GB',
      }),
    );
    expect(html).toContain('<time datetime="2026-03-05">5 March 2026</time>');
    expect(html).toContain('<meta property="og:type" content="article">');
    expect(html).toContain('<li><a href="/tags/news/">news</a></li>');
    expect(html).toContain('<li>aws</li>');
  });

  it('renders a default 404 body when there is no content', () => {
    const html = renderer.render('404', context({ title: 'Page not found', url: '/404.html' }, ''));
    expect(html).toContain('<a href="/">Go to the home page</a>');
  });

  it('knows which layouts exist', () => {
    expect(renderer.hasLayout('post')).toBe(true);
    expect(renderer.hasLayout('gallery')).toBe(false);
  });
});

describe('createRenderer overrides and errors', () => {
  it('prefers templates/ in the project over the theme', () => {
    const root = tempDir({
      'templates/partials/footer.njk': '<footer>Custom footer</footer>',
      'templates/layouts/gallery.njk':
        '{% extends "layouts/base.njk" %}{% block main %}Gallery{% endblock %}',
    });
    const renderer = createRenderer(loadTheme('default', root), {
      rootDir: root,
      baseUrl: 'https://example.com',
    });
    expect(renderer.hasLayout('gallery')).toBe(true);
    const html = renderer.render('gallery', context());
    expect(html).toContain('<footer>Custom footer</footer>');
    expect(html).toContain('Gallery');
  });

  it('wraps template errors as SF_THEME_INVALID', () => {
    const root = tempDir({ 'templates/layouts/broken.njk': '{% if %}' });
    const renderer = createRenderer(loadTheme('default', root), {
      rootDir: root,
      baseUrl: 'https://example.com',
    });
    expect(() => renderer.render('broken', context())).toThrow(
      expect.objectContaining({
        code: ErrorCode.ThemeInvalid,
        message: expect.stringContaining('"broken"'),
      }),
    );
  });
});
