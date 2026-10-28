import { toHtml } from 'hast-util-to-html';
import { describe, expect, it } from 'vitest';
import {
  type ParseOptions,
  extractFrontMatter,
  parseContent,
  prepareSource,
  startsDocument,
  titleFromPath,
} from '../src/index.js';

async function md(source: string, options: Partial<ParseOptions> = {}, path = 'content/page.md') {
  const parsed = await parseContent(prepareSource(source, path, 'markdown'), {
    language: 'en',
    ...options,
  });
  return { ...parsed, html: toHtml(parsed.tree) };
}

async function html(source: string, options: Partial<ParseOptions> = {}) {
  const parsed = await parseContent(prepareSource(source, 'content/page.html', 'html'), {
    language: 'en',
    ...options,
  });
  return { ...parsed, html: toHtml(parsed.tree) };
}

const ruleIds = (diagnostics: { ruleId: string }[]) => diagnostics.map((d) => d.ruleId);

describe('extractFrontMatter', () => {
  it('parses YAML and keeps line numbers by blanking the block', () => {
    const fm = extractFrontMatter('---\ntitle: Hi\ntags: [a]\n---\n# Body\n', 'x.md');
    expect(fm.present).toBe(true);
    expect(fm.data).toEqual({ title: 'Hi', tags: ['a'] });
    expect(fm.body).toBe('\n\n\n\n# Body\n');
    expect(fm.keyLines).toEqual({ title: 2, tags: 3 });
  });

  it('accepts an empty block and a leading BOM', () => {
    expect(extractFrontMatter('﻿---\n---\nx', 'x.md')).toMatchObject({ present: true, data: {} });
  });

  it('returns the source untouched without front-matter', () => {
    expect(extractFrontMatter('# Hi\n---\n', 'x.md')).toMatchObject({
      present: false,
      body: '# Hi\n---\n',
    });
  });

  it('reports YAML syntax errors with the source line', () => {
    const fm = extractFrontMatter('---\ntitle: Hi\nbad: [unclosed\n---\n', 'x.md');
    expect(fm.diagnostics[0]).toMatchObject({
      ruleId: 'frontmatter-yaml',
      severity: 'error',
      file: 'x.md',
    });
    expect(fm.diagnostics[0]?.line).toBeGreaterThanOrEqual(3);
  });

  it('rejects non-mapping front-matter', () => {
    expect(ruleIds(extractFrontMatter('---\n- a\n---\n', 'x.md').diagnostics)).toEqual([
      'frontmatter-yaml',
    ]);
  });
});

describe('prepareSource', () => {
  it('validates known keys, coerces dates and keeps custom keys', () => {
    const prepared = prepareSource(
      '---\ntitle: Post\ndate: 2026-10-01\nhero: big\n---\n',
      'content/post.md',
      'markdown',
    );
    expect(prepared.diagnostics).toEqual([]);
    expect(prepared.meta).toMatchObject({ title: 'Post', hero: 'big', draft: false, tags: [] });
    expect(prepared.meta.date).toEqual(new Date('2026-10-01'));
  });

  it('drops invalid keys, reporting each at its line', () => {
    const prepared = prepareSource(
      '---\ntitle: Ok\nslug: Not Valid\ndraft: maybe\n---\n',
      'content/x.md',
      'markdown',
    );
    expect(prepared.meta.title).toBe('Ok');
    expect(prepared.meta.slug).toBeUndefined();
    expect(prepared.diagnostics.map((d) => [d.ruleId, d.line])).toEqual([
      ['frontmatter-invalid', 3],
      ['frontmatter-invalid', 4],
    ]);
  });
});

describe('parseContent: markdown', () => {
  it('uses a leading # heading as the title and removes it from the content', async () => {
    const page = await md('# Hello world\n\nIntro.\n\n## Section\n');
    expect(page.title).toBe('Hello world');
    expect(page.html).not.toContain('<h1');
    expect(page.headings).toEqual([{ depth: 2, id: 'section', text: 'Section' }]);
    expect(page.diagnostics).toEqual([]);
  });

  it('removes a leading heading that repeats the front-matter title', async () => {
    const page = await md('---\ntitle: Same\n---\n# Same\n\nText\n');
    expect(page.html).not.toContain('Same');
  });

  it('demotes headings when the content has its own h1s', async () => {
    const page = await md('---\ntitle: Page\n---\n# Other\n\n## Sub\n');
    expect(page.html).toContain('<h2 id="other">');
    expect(page.html).toContain('<h3 id="sub">');
    expect(ruleIds(page.diagnostics)).toEqual(['heading-shift']);
  });

  it('falls back to a title from the file name, with a warning', async () => {
    const page = await md('Just text.\n', {}, 'content/about-us.md');
    expect(page.title).toBe('About us');
    expect(page.diagnostics[0]).toMatchObject({ ruleId: 'page-title', wcag: '2.4.2' });
  });

  it('wraps headings in self-links', async () => {
    const page = await md('## Install it\n');
    expect(page.html).toContain('<h2 id="install-it"><a href="#install-it">Install it</a></h2>');
  });

  it('does not nest links in headings that already contain one', async () => {
    const page = await md('## See [docs](https://example.com)\n');
    expect(page.html.match(/<a /g)).toHaveLength(1);
  });

  it('supports GFM tables, task lists and footnotes', async () => {
    const page = await md(
      '| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n\nNote[^1]\n\n[^1]: Footnote.\n',
    );
    expect(page.html).toContain('<table>');
    expect(page.html).toContain('type="checkbox"');
    expect(page.html).toContain('data-footnotes');
  });

  it('labels task list checkboxes with their item text', async () => {
    const tight = await md('- [x] Write docs\n  - nested\n- [ ] Ship\n');
    expect(tight.html).toContain(
      '<label><input type="checkbox" checked disabled> Write docs</label>\n<ul>',
    );
    expect(tight.html).toContain('<label><input type="checkbox" disabled> Ship</label>');

    const loose = await md('- [x] First\n\n- [ ] Second\n');
    expect(loose.html).toContain(
      '<p><label><input type="checkbox" checked disabled> First</label></p>',
    );
  });

  it('highlights code with dual light/dark themes and keeps blocks focusable', async () => {
    const page = await md('```js\nconst a = 1;\n```\n');
    expect(page.html).toContain('class="shiki shiki-themes github-light github-dark-default"');
    expect(page.html).toContain('--shiki-dark:');
    expect(page.html.match(/tabindex="0"/g)).toHaveLength(1);
  });

  it('makes code blocks and tables keyboard-scrollable', async () => {
    const page = await md(
      '```\nplain\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n<table><caption>Prices</caption><tr><td>1</td></tr></table>\n',
    );
    expect(page.html).toContain('<pre tabindex="0"><code>plain');
    expect(page.html).toMatch(/<div class="table-scroll" tabindex="0"><table>\s*<thead>/);
    expect(page.html).toContain(
      '<div class="table-scroll" tabindex="0" role="region" aria-label="Prices"><table><caption>Prices</caption>',
    );
  });

  it('falls back to plain text for unknown languages', async () => {
    const page = await md('```nosuchlang\nx\n```\n');
    expect(page.html).toContain('<pre');
  });
});

describe('parseContent: images and video', () => {
  it('lazy-loads images and flags empty alt text', async () => {
    const page = await md('# T\n\n![](photo.jpg)\n');
    expect(page.html).toContain('loading="lazy"');
    expect(page.html).toContain('decoding="async"');
    expect(page.diagnostics).toEqual([
      expect.objectContaining({ ruleId: 'img-alt', severity: 'warning', line: 3, column: 1 }),
    ]);
  });

  it('accepts decorative images and errors on a missing alt attribute', async () => {
    const page = await html('<img src="a.png" alt="" role="presentation"><img src="b.png">');
    expect(page.diagnostics.map((d) => [d.ruleId, d.severity])).toEqual([
      ['page-title', 'warning'],
      ['img-alt', 'error'],
    ]);
  });

  it('turns video "images" into captioned video elements', async () => {
    const page = await md('# T\n\n![Launch demo](/media/demo.mp4)\n', {
      fileExists: (path) => path === '/media/demo.vtt',
    });
    expect(page.html).toContain(
      '<figure><video src="/media/demo.mp4" controls preload="metadata">',
    );
    expect(page.html).toContain(
      '<track kind="captions" src="/media/demo.vtt" srclang="en" label="Captions" default>',
    );
    expect(page.html).toContain('<figcaption>Launch demo</figcaption>');
    expect(page.diagnostics).toEqual([]);
  });

  it('warns about videos without captions', async () => {
    const page = await md('# T\n\n![Demo](/media/demo.webm)\n');
    expect(page.diagnostics[0]).toMatchObject({
      ruleId: 'video-captions',
      wcag: '1.2.2',
      hint: expect.stringContaining('/media/demo.vtt'),
    });
  });
});

describe('parseContent: links', () => {
  it('marks new-tab links and announces them', async () => {
    const page = await html('<h1>T</h1><a href="https://x.test" target="_blank">X</a>');
    expect(page.html).toContain(
      '<a href="https://x.test" target="_blank" rel="noopener noreferrer">X<span class="visually-hidden"> (opens in a new tab)</span></a>',
    );
  });

  it('rewrites references through resolveRef, including srcset', async () => {
    const page = await html(
      '<h1>T</h1><a href="b.md#x">B</a><img alt="i" srcset="a.png 1x, b.png 2x">',
      {
        resolveRef: (ref) => (ref.startsWith('/') ? undefined : `/r/${ref}`),
      },
    );
    expect(page.html).toContain('href="/r/b.md#x"');
    expect(page.html).toContain('srcset="/r/a.png 1x, /r/b.png 2x"');
  });
});

describe('parseContent: HTML', () => {
  it('passes full documents through without wrapping', async () => {
    const page = await html(
      '<!doctype html><html lang="en"><head><title>Doc</title></head><body><h1>Doc</h1></body></html>',
    );
    expect(page.kind).toBe('document');
    expect(page.title).toBe('Doc');
    expect(page.html).toContain('<h1>Doc</h1>');
  });

  it('wraps the body of a full document that has front-matter', async () => {
    const page = await html(
      '---\ntitle: Wrapped\n---\n<!doctype html><html><head><title>X</title></head><body><p>Body</p></body></html>',
    );
    expect(page.kind).toBe('fragment');
    expect(page.title).toBe('Wrapped');
    expect(page.html).toBe('<p>Body</p>');
  });

  it('treats markup without a doctype or <html> as a fragment', async () => {
    const page = await html('<h1>Frag</h1><p>x</p>');
    expect(page.kind).toBe('fragment');
    expect(page.title).toBe('Frag');
  });

  it('reports malformed HTML with its position', async () => {
    const page = await html('<h1>T</h1>\n<p id="a" id="b">x</p>');
    expect(page.diagnostics.find((d) => d.ruleId === 'html-parse')).toMatchObject({
      severity: 'warning',
      line: 2,
      column: 13,
      message: expect.stringContaining('duplicate attribute'),
    });
  });
});

describe('titleFromPath', () => {
  it('humanizes file and section names', () => {
    expect(titleFromPath('content/getting_started.md')).toBe('Getting started');
    expect(titleFromPath('content/blog/index.md')).toBe('Blog');
  });
});

describe('startsDocument', () => {
  it('recognizes a doctype or html element after whitespace and comments', () => {
    expect(startsDocument('<!doctype html><title>x</title>')).toBe(true);
    expect(startsDocument('  \n<!-- a -->\n<!-- b -->  <HTML lang="en">')).toBe(true);
    expect(startsDocument('<!---->\n<html>')).toBe(true);
    expect(startsDocument('<p>fragment</p>')).toBe(false);
    expect(startsDocument('<!-- never closed <html>')).toBe(false);
    expect(startsDocument('<!--> <html>')).toBe(false);
    expect(startsDocument('')).toBe(false);
  });

  it('stays fast on long runs of comments and whitespace', () => {
    const started = performance.now();
    for (const body of [
      '<!-- a -->'.repeat(20_000) + 'x',
      '<!-- a -->  '.repeat(20_000) + 'x',
      `<!--${' '.repeat(100_000)}x`,
      `${' '.repeat(100_000)}x`,
    ]) {
      expect(startsDocument(body)).toBe(false);
    }
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
