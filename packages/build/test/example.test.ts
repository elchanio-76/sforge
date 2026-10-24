import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@staticforge/core';
import { buildSite } from '../src/index.js';
import { read } from './helpers.js';

const exampleDir = new URL('../../../examples/basic-site/', import.meta.url).pathname;
const coreEntry = new URL('../../core/src/index.ts', import.meta.url).pathname;

describe('examples/basic-site', () => {
  const outDir = `test-dist-${process.pid}`;
  afterAll(() => rmSync(join(exampleDir, outDir), { recursive: true, force: true }));

  it('builds with no diagnostics', async () => {
    const { config, rootDir } = await loadConfig({
      cwd: exampleDir,
      aliases: { staticforge: coreEntry },
    });
    const result = await buildSite({ rootDir, config, outDir });

    expect(result.diagnostics).toEqual([]);
    expect(result.pages.map((p) => `${p.url} ${p.layout}`).sort()).toEqual([
      '/ page',
      '/404.html 404',
      '/about/ page',
      '/blog/ list',
      '/blog/hello/ post',
      '/blog/images/ post',
      '/blog/page/2/ list',
      '/blog/search/ post',
      '/contact/ page',
      '/guides/ page',
      '/guides/markdown/ page',
      '/legacy/ document',
      '/search/ search',
      '/tags/ tags',
      '/tags/announcement/ tag',
      '/tags/images/ tag',
      '/tags/release/ tag',
    ]);

    const guide = read(result.outDir, 'guides/markdown/index.html');
    expect(guide).toContain(
      '<img src="/guides/diagram.svg" alt="A diagram of content flowing from Markdown to HTML"',
    );
    expect(guide).toMatch(
      /<script type="module" src="\/assets\/js\/site\.[0-9a-f]{8}\.js"><\/script>/,
    );
    expect(read(result.outDir, 'blog/images/index.html')).toContain(
      'width="1600" height="900"></picture>',
    );
    for (const file of ['blog/feed.xml', 'blog/atom.xml', 'sitemap.xml', 'pagefind/pagefind.js']) {
      expect(existsSync(join(result.outDir, file)), file).toBe(true);
    }
    expect(read(result.outDir, 'index.html')).toContain(
      '<a href="/legacy/">A complete HTML document</a>',
    );
    expect(existsSync(join(result.outDir, 'robots.txt'))).toBe(true);
  });
});
