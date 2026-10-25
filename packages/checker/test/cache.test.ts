import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BuildCache, buildSite } from '@staticforge/build';
import { CheckCache, checkBuild, finalizeDiagnostics } from '../src/index.js';
import { config, tempProject } from './helpers.js';

describe('checking with a cache', () => {
  it('re-runs only the rules whose inputs changed, finding the same problems', async () => {
    const root = tempProject({
      'content/index.md': '---\ntitle: Home\n---\n\nSee [the guide](guide.md#setup).\n',
      'content/guide.md': '---\ntitle: Guide\n---\n\n## Setup\n\nText.\n',
      'content/about.md': '---\ntitle: About\n---\n\n#### Too deep\n',
    });
    const site = config({ search: { enabled: false } });
    const buildCache = new BuildCache();
    const checkCache = new CheckCache();
    let n = 0;

    /** Rebuild, then check with and without the cache: both must agree. */
    const step = async () => {
      const build = await buildSite({
        rootDir: root,
        config: site,
        cache: buildCache,
        outDir: `out-${++n}`,
      });
      const check = async (cache?: CheckCache) =>
        finalizeDiagnostics(
          (await checkBuild({ rootDir: root, config: site, build, headless: false, cache }))
            .findings,
          [],
        );
      const cached = await check(checkCache);
      expect(cached).toEqual(await check());
      return cached.map((d) => `${d.ruleId} ${d.url}`);
    };

    expect(await step()).toEqual(['heading-order /about/']);
    const pages = checkCache.stats.validated;
    expect(checkCache.stats).toEqual({ sources: 3, validated: pages, output: pages });

    await step();
    expect(checkCache.stats).toEqual({ sources: 0, validated: 0, output: 0 });

    // A body edit: one source, one page; the site's files and ids are unchanged.
    writeFileSync(join(root, 'content/about.md'), '---\ntitle: About\n---\n\n## Too deep\n');
    expect(await step()).toEqual([]);
    expect(checkCache.stats).toEqual({ sources: 1, validated: 1, output: 1 });

    // Renaming a heading changes the ids links can point at: every page's links are checked again.
    writeFileSync(
      join(root, 'content/guide.md'),
      '---\ntitle: Guide\n---\n\n## Install\n\nText.\n',
    );
    expect(await step()).toEqual(['link-fragment /']);
    expect(checkCache.stats).toEqual({ sources: 1, validated: 1, output: pages });
  });
});
