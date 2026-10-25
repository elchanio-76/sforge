import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MANIFEST_PATH, buildSite } from '../src/index.js';
import { PNG, config, read, tempProject } from './helpers.js';

const site = {
  'content/index.md':
    '---\ntitle: Home\n---\nSee [about](about.md) and [the post](blog/hello.md#intro).\n',
  'content/about.md':
    '---\ntitle: About us\nnav:\n  order: 1\n---\n# About us\n\n![Team photo](team.png)\n',
  'content/team.png': PNG,
  'content/blog/hello.md':
    '---\ntitle: Hello\nlayout: post\ndate: 2026-01-02\ntags: [news]\n---\n## Intro\n\n![Demo](demo.mp4)\n',
  'content/blog/demo.mp4': 'video',
  'content/blog/demo.vtt': 'WEBVTT',
  'content/blog/secret.md': '---\ntitle: Secret\ndraft: true\n---\nShh.\n',
  'content/contact.html': '<h1>Contact</h1><p><a href="index.md">Home</a></p>',
  'content/legacy.html':
    '<!doctype html><html><head><meta charset="utf-8"><title>Legacy</title><link rel="stylesheet" href="legacy.css"></head><body><img src="team.png" alt="Team"></body></html>',
  'content/legacy.css': 'body{}',
  'assets/css/site.css': ':root{}',
  'static/robots.txt': 'User-agent: *\n',
  'data/links.yaml': '- name: Example\n',
};

describe('buildSite', () => {
  it('builds pages, copies files and writes a manifest', async () => {
    const root = tempProject(site);
    const result = await buildSite({
      rootDir: root,
      config: config({ styles: ['/assets/css/site.css'] }),
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.pages.map((p) => [p.url, p.layout])).toEqual([
      ['/', 'page'],
      ['/404.html', '404'],
      ['/about/', 'page'],
      ['/blog/hello/', 'post'],
      ['/contact/', 'page'],
      ['/legacy/', 'document'],
      ['/search/', 'search'],
      ['/tags/', 'tags'],
      ['/tags/news/', 'tag'],
    ]);
    expect(result.drafts.skipped).toEqual(['content/blog/secret.md']);

    for (const file of [
      'index.html',
      'about/index.html',
      'team.png',
      'blog/demo.mp4',
      'assets/css/site.css',
      'assets/theme/css/theme.css',
      'robots.txt',
      'sitemap.xml',
      '404.html',
      'pagefind/pagefind.js',
    ]) {
      expect(existsSync(join(result.outDir, file)), file).toBe(true);
    }
    expect(existsSync(join(result.outDir, 'blog/secret/index.html'))).toBe(false);

    const manifest = JSON.parse(read(result.outDir, MANIFEST_PATH));
    expect(Object.keys(manifest.files)).toHaveLength(result.fileCount);
    expect(manifest.files['robots.txt']).toEqual({
      sha256: createHash('sha256').update('User-agent: *\n').digest('hex'),
      size: 14,
      cache: 'revalidate',
    });
    const hashed = Object.entries(manifest.files).filter(
      ([, entry]) => (entry as { cache: string }).cache === 'immutable',
    );
    expect(hashed.map(([file]) => file)).toContainEqual(
      expect.stringMatching(/^assets\/css\/site\.[0-9a-f]{8}\.css$/),
    );
  });

  it('rewrites source links to page URLs and co-located files to root-relative URLs', async () => {
    const root = tempProject(site);
    const { outDir } = await buildSite({ rootDir: root, config: config() });

    expect(read(outDir, 'index.html')).toContain(
      '<a href="/about/">about</a> and <a href="/blog/hello/#intro">',
    );
    expect(read(outDir, 'about/index.html')).toMatch(
      /srcset="\/_assets\/img\/team-[0-9a-f]{10}-64\.png 64w"/,
    );
    expect(read(outDir, 'contact/index.html')).toContain('<a href="/">Home</a>');
  });

  it('links captions next to videos and renders posts with their layout', async () => {
    const { outDir } = await buildSite({ rootDir: tempProject(site), config: config() });
    const post = read(outDir, 'blog/hello/index.html');
    expect(post).toContain(
      '<track kind="captions" src="/blog/demo.vtt" srclang="en" label="Captions" default>',
    );
    expect(post).toContain('<time datetime="2026-01-02">January 2, 2026</time>');
    expect(post).toContain('<h2 id="intro">');
  });

  it('wraps HTML fragments and passes documents through with styles injected', async () => {
    const { outDir } = await buildSite({
      rootDir: tempProject(site),
      config: config({ styles: ['/assets/css/site.css'] }),
    });
    const contact = read(outDir, 'contact/index.html');
    expect(contact).toContain('<title>Contact | Test</title>');
    expect(contact.match(/<h1/g)).toHaveLength(1);

    const legacy = read(outDir, 'legacy/index.html');
    expect(legacy).toMatch(
      /<meta charset="utf-8"><link rel="stylesheet" href="\/assets\/theme\/css\/theme\.[0-9a-f]{8}\.css"><link rel="stylesheet" href="\/assets\/css\/site\.[0-9a-f]{8}\.css"><title>Legacy<\/title><link rel="stylesheet" href="\/legacy\.css">/,
    );
    // Documents are the author's: their images are not rewritten.
    expect(legacy).toContain('<img src="/team.png" alt="Team">');
    expect(legacy).not.toContain('skip-link');
  });

  it('builds navigation with the current page marked', async () => {
    const { outDir } = await buildSite({ rootDir: tempProject(site), config: config() });
    const about = read(outDir, 'about/index.html');
    const nav = about.slice(about.indexOf('<nav'), about.indexOf('</nav>'));
    expect(nav).toContain('<a href="/about/" aria-current="page">About us</a>');
    expect(nav).toContain('<a href="/contact/">Contact</a>');
    expect(nav).toContain('<a href="/legacy/">Legacy</a>');
    expect(nav).not.toContain('/blog/hello/');
    expect(nav.indexOf('About us')).toBeLessThan(nav.indexOf('Contact'));
  });

  it('includes drafts on request and honours --base-url and --out', async () => {
    const root = tempProject(site);
    const result = await buildSite({
      rootDir: root,
      config: config(),
      drafts: true,
      baseUrl: 'https://preview.example.com',
      outDir: 'preview',
    });
    expect(result.outDir).toBe(join(root, 'preview'));
    expect(read(result.outDir, 'blog/secret/index.html')).toContain(
      '<link rel="canonical" href="https://preview.example.com/blog/secret/">',
    );
  });

  it('marks every page noindex in preview builds', async () => {
    const root = tempProject({
      ...site,
      'content/kept.html':
        '<!doctype html><html><head><title>Kept</title><meta name="robots" content="index, follow"></head><body><h1>Kept</h1></body></html>',
    });
    const noindex = '<meta name="robots" content="noindex">';
    const preview = await buildSite({ rootDir: root, config: config(), noindex: true });
    // Theme pages, documents with their own <head>, and generated pages alike.
    for (const file of ['index.html', 'about/index.html', 'legacy/index.html', '404.html']) {
      expect(read(preview.outDir, file), file).toContain(noindex);
    }
    expect(read(preview.outDir, 'kept/index.html')).toContain(noindex);
    expect(read(preview.outDir, 'kept/index.html')).not.toContain('index, follow');

    const production = await buildSite({ rootDir: root, config: config() });
    expect(read(production.outDir, 'index.html')).not.toContain('name="robots"');
  });

  it('uses a content 404 page with the 404 layout', async () => {
    const root = tempProject({
      'content/404.md': '---\ntitle: Lost\n---\nTry the [home page](index.md).\n',
      'content/index.md': '# Home\n',
    });
    const result = await buildSite({ rootDir: root, config: config() });
    expect(result.pages.find((p) => p.url === '/404.html')).toMatchObject({
      source: 'content/404.md',
      layout: '404',
    });
    expect(read(result.outDir, '404.html')).toContain('Try the <a href="/">home page</a>');
  });

  it('exposes data/ files to project template overrides', async () => {
    const root = tempProject({
      ...site,
      'templates/partials/footer.njk':
        '<footer>{% for l in data.links %}{{ l.name }}{% endfor %}</footer>',
    });
    const { outDir } = await buildSite({ rootDir: root, config: config() });
    expect(read(outDir, 'index.html')).toContain('<footer>Example</footer>');
  });

  it('reports content problems as diagnostics and marks the build failed on errors', async () => {
    const root = tempProject({
      'content/index.md': '---\ntitle: Home\nlayout: gallery\n---\n<img src="x.png">\n',
      'content/about.md': '# A\n',
      'content/about/index.md': '# B\n',
      'data/bad.json': '{',
    });
    const result = await buildSite({
      rootDir: root,
      config: config({ styles: ['/assets/missing.css'] }),
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => [d.ruleId, d.file])).toEqual([
      ['asset-missing', undefined],
      ['output-conflict', 'content/about/index.md'],
      ['layout-missing', 'content/index.md'],
      ['img-alt', 'content/index.md'],
      ['data-invalid', 'data/bad.json'],
    ]);
    expect(result.summary).toEqual({ error: 5, warning: 0, info: 0 });
    // The page still builds with the default layout so authors can preview it.
    expect(existsSync(join(result.outDir, 'index.html'))).toBe(true);
  });

  it('replaces the previous output', async () => {
    const root = tempProject(site);
    const first = await buildSite({ rootDir: root, config: config() });
    expect(existsSync(join(first.outDir, 'contact/index.html'))).toBe(true);
    rmSync(join(root, 'content/contact.html'));
    await buildSite({ rootDir: root, config: config() });
    expect(existsSync(join(first.outDir, 'contact/index.html'))).toBe(false);
    // The home page's <title> is the site title.
    expect(readFileSync(join(first.outDir, 'index.html'), 'utf8')).toContain('<title>Test</title>');
  });
});
