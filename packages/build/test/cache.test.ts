import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BuildCache, MANIFEST_PATH, buildSite } from '../src/index.js';
import { config, read, tempProject } from './helpers.js';

const PAGE_LAYOUT = readFileSync(
  new URL('../../theme-default/layouts/page.njk', import.meta.url),
  'utf8',
);

describe('building with a cache', () => {
  it('parses and renders only what changed, with the same output as a cold build', async () => {
    const root = tempProject({
      'content/index.md': '---\ntitle: Home\n---\n\nSee [the guide](guide.md) and [B](b.md).\n',
      'content/guide.md': '---\ntitle: Guide\n---\n\nAlpha.\n',
      'static/video.mp4': 'v1',
      'templates/layouts/page.njk': PAGE_LAYOUT,
    });
    const site = config({ search: { enabled: false } });
    const cache = new BuildCache();
    let n = 0;
    const build = () => buildSite({ rootDir: root, config: site, cache, outDir: `out-${++n}` });
    const files = (dir: string) => JSON.parse(read(root, join(dir, MANIFEST_PATH))).files;

    const first = await build();
    const pages = first.pages.length;
    expect(first.diagnostics.map((d) => d.ruleId)).toEqual(['link-broken']);
    expect(cache.stats).toEqual({ parsed: 2, rendered: pages, linked: 0 });

    const unchanged = await build();
    expect(cache.stats).toEqual({ parsed: 0, rendered: 0, linked: 1 });
    expect(unchanged.diagnostics).toEqual(first.diagnostics);
    expect(files('out-2')).toEqual(files('out-1'));
    expect(statSync(join(root, 'out-2/video.mp4')).nlink).toBe(2);
    // The same as without a cache (whose build time differs, which the default theme only shows as a year).
    await buildSite({ rootDir: root, config: site, outDir: 'cold' });
    expect(files('out-2')).toEqual(files('cold'));

    writeFileSync(join(root, 'content/guide.md'), '---\ntitle: Guide\n---\n\nBeta.\n');
    await build();
    expect(cache.stats).toMatchObject({ parsed: 1, rendered: 1 });
    expect(read(root, 'out-3/guide/index.html')).toContain('Beta.');

    // A new page changes what links resolve to: every page is parsed again.
    writeFileSync(join(root, 'content/b.md'), '---\ntitle: B\n---\n\nNew.\n');
    const added = await build();
    expect(added.diagnostics).toEqual([]);
    expect(cache.stats.parsed).toBe(3);

    writeFileSync(join(root, 'static/video.mp4'), 'v2 longer');
    writeFileSync(
      join(root, 'templates/layouts/page.njk'),
      PAGE_LAYOUT.replace('class="page"', 'class="page edited"'),
    );
    const edited = await build();
    expect(cache.stats).toMatchObject({ parsed: 0, linked: 0 });
    // Templates include each other, so a template change renders every page again.
    expect(cache.stats.rendered).toBe(edited.pages.length);
    expect(read(root, 'out-5/video.mp4')).toBe('v2 longer');
    expect(read(root, 'out-5/guide/index.html')).toContain('class="page edited"');
    // Earlier builds keep their own contents.
    expect(read(root, 'out-4/video.mp4')).toBe('v1');
  });
});
