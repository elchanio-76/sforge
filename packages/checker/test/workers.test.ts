import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MANIFEST_PATH, buildSite } from '@staticforge/build';
import { createWorkerPool } from '@staticforge/core';
import { checkBuild, finalizeDiagnostics } from '../src/index.js';
import { config, tempProject } from './helpers.js';

/** Enough pages to use workers, with problems of each layer. */
function site(): Record<string, string> {
  const files: Record<string, string> = {
    'content/index.md': '---\ntitle: Home\n---\n\nWelcome. [Missing](missing.md)\n',
    'content/blog/_index.md': '---\ntitle: Blog\n---\n\nPosts.\n',
    'content/odd.md': '---\ntitle: Odd\nlayout: nonexistent\n---\n\nText.\n',
    'content/legacy.html':
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Legacy</title></head><body><main id="main"><p>Old</p></main></body></html>',
  };
  for (let i = 0; i < 120; i++) {
    const problems = i % 30 === 0 ? '\n#### Skipped level\n\n<img src="x.svg">\n' : '';
    files[`content/guides/g${i}.md`] =
      `---\ntitle: Guide ${i}\ntags: [t${i % 5}]\n---\n\nSee [next](g${i + 1}.md) and [a heading](g0.md#background).\n\n## Background\n\n\`\`\`js\nconst n = ${i};\n\`\`\`\n${problems}`;
  }
  for (let i = 0; i < 40; i++) {
    files[`content/blog/p${i}.md`] =
      `---\ntitle: Post ${i}\ndate: 2026-01-${String((i % 28) + 1).padStart(2, '0')}\n---\n\nPost body ${i}.\n`;
  }
  files['content/guides/x.svg'] = '<svg xmlns="http://www.w3.org/2000/svg"/>';
  return files;
}

const pool = createWorkerPool(3);
afterAll(() => pool.close());

describe('worker threads', () => {
  it('build and check the same as the main thread alone', { timeout: 60_000 }, async () => {
    const root = tempProject(site());
    const options = (workers: number) => ({
      rootDir: root,
      config: config({
        build: { workers },
        collections: { blog: { dir: 'content/blog' } },
      }),
    });

    const local = await buildSite({ ...options(0), outDir: 'dist-local' });
    const pooled = await buildSite({ ...options(3), outDir: 'dist-pooled', pool });
    expect(local.pages.length).toBeGreaterThan(150);

    const files = (dir: string) =>
      JSON.parse(readFileSync(join(root, dir, MANIFEST_PATH), 'utf8')).files as Record<
        string,
        unknown
      >;
    expect(files('dist-pooled')).toEqual(files('dist-local'));
    expect(pooled.diagnostics).toEqual(local.diagnostics);
    expect(pooled.pages).toEqual(local.pages);
    const rules = new Set(local.diagnostics.map((d) => d.ruleId));
    expect(rules).toEqual(new Set(['layout-missing', 'link-broken', 'img-alt']));

    const findings = async (usePool: boolean) => {
      const checked = await checkBuild({
        ...options(usePool ? 3 : 0),
        build: local,
        headless: false,
        ...(usePool && { pool }),
      });
      return finalizeDiagnostics(checked.findings, []);
    };
    const checkedLocal = await findings(false);
    expect(await findings(true)).toEqual(checkedLocal);
    expect(checkedLocal.map((d) => d.ruleId)).toEqual(
      expect.arrayContaining(['heading-order', 'img-alt', 'link-broken', 'meta-viewport']),
    );
  });
});
