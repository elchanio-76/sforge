import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '@staticforge/core';
import { buildSite, initProject, newContent } from '../src/index.js';
import { read } from './helpers.js';

const coreEntry = new URL('../../core/src/index.ts', import.meta.url).pathname;
const urls = { cleanUrls: true, trailingSlash: 'always' } as const;

describe('initProject', () => {
  it.each(['ts', 'json', 'yaml'] as const)(
    'writes a %s config that loads, and a site that builds cleanly',
    async (format) => {
      const dir = join(mkdtempSync(join(tmpdir(), 'sforge-init-')), 'my-blog');
      const result = initProject({ dir, format, provider: 'azure', region: 'northeurope' });

      expect(result.created).toEqual([
        `staticforge.config.${format}`,
        'content/index.md',
        'content/about.md',
        'assets/css/site.css',
        '.gitignore',
      ]);
      const loaded = await loadConfig({ cwd: dir, aliases: { staticforge: coreEntry } });
      expect(loaded.config.site.title).toBe('My blog');
      expect(loaded.config.targets.staging).toMatchObject({
        provider: 'azure',
        resourceGroup: 'rg-my-blog',
        location: 'northeurope',
      });

      const build = await buildSite({ rootDir: dir, config: loaded.config });
      expect(build.diagnostics).toEqual([]);
      expect(build.pages.map((p) => p.url)).toEqual(['/', '/404.html', '/about/', '/search/']);
    },
  );

  it('refuses to initialize over an existing project unless forced', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sforge-init-'));
    initProject({ dir, format: 'json' });
    expect(() => initProject({ dir })).toThrow(expect.objectContaining({ code: 'SF_FILE_EXISTS' }));
    const forced = initProject({ dir, format: 'json', force: true, title: 'Renamed' });
    expect(forced.created).toContain('staticforge.config.json');
    expect(read(dir, 'staticforge.config.json')).toContain('"title": "Renamed"');
  });

  it('skips existing starter files in a directory without a config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sforge-init-'));
    newContent({ rootDir: dir, kind: 'page', path: 'index', title: 'Mine', urls });
    const result = initProject({ dir, format: 'json' });
    expect(result.skipped).toEqual(['content/index.md']);
    expect(read(dir, 'content/index.md')).toContain('title: Mine');
  });
});

describe('newContent', () => {
  it('creates pages and posts with front-matter and returns the URL', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'sforge-new-'));
    expect(newContent({ rootDir, kind: 'page', path: 'guides/getting-started', urls })).toEqual({
      file: 'content/guides/getting-started.md',
      url: '/guides/getting-started/',
    });
    expect(read(rootDir, 'content/guides/getting-started.md')).toBe(
      '---\ntitle: Getting started\n---\n\nWrite your content here.\n',
    );

    const post = newContent({
      rootDir,
      kind: 'post',
      path: 'launch',
      title: 'We launched: v1',
      draft: true,
      date: new Date('2026-10-24T12:00:00Z'),
      urls,
    });
    expect(post).toEqual({ file: 'content/blog/launch.md', url: '/blog/launch/' });
    expect(read(rootDir, post.file)).toBe(
      '---\ntitle: "We launched: v1"\nlayout: post\ndate: 2026-10-24\ntags: []\ndraft: true\n---\n\nWrite your content here.\n',
    );
  });

  it('creates HTML fragments', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'sforge-new-'));
    const page = newContent({
      rootDir,
      kind: 'page',
      path: 'content/contact.html',
      format: 'html',
      urls,
    });
    expect(page.file).toBe('content/contact.html');
    expect(read(rootDir, page.file)).toContain('<p>Write your content here.</p>');
  });

  it('rejects unsafe paths and existing files', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'sforge-new-'));
    for (const path of ['../escape', 'a/../../b', 'a//b', 'bad name', '']) {
      expect(() => newContent({ rootDir, kind: 'page', path, urls }), path).toThrow(
        expect.objectContaining({ code: 'SF_USAGE' }),
      );
    }
    expect(newContent({ rootDir, kind: 'page', path: '/x', urls }).file).toBe('content/x.md');
    expect(() => newContent({ rootDir, kind: 'page', path: 'x', urls })).toThrow(
      expect.objectContaining({ code: 'SF_FILE_EXISTS' }),
    );
    expect(() => newContent({ rootDir, kind: 'page', path: 'x', force: true, urls })).not.toThrow();
  });
});
