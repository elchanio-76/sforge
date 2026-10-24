import { describe, expect, it } from 'vitest';
import { prepareSource } from '@staticforge/content';
import { checkSource } from '../src/source-rules.js';
import { applyEdits } from '../src/text.js';
import type { CheckPage, Finding } from '../src/types.js';

const PAGES = {
  'content/index.md': '/',
  'content/about.md': '/about/',
  'content/blog/post.md': '/blog/post/',
};

function check(
  path: string,
  text: string,
  options: {
    kind?: CheckPage['kind'];
    url?: string;
    pages?: Record<string, string>;
    trailingSlash?: 'always' | 'never';
  } = {},
): Finding[] {
  const format = path.endsWith('.md') ? 'markdown' : 'html';
  return checkSource({
    page: {
      url: options.url ?? '/page/',
      source: path,
      output: 'page/index.html',
      kind: options.kind ?? 'fragment',
    },
    text,
    prepared: prepareSource(text, path, format),
    language: 'en',
    pageUrls: new Map(Object.entries(options.pages ?? PAGES)),
    trailingSlash: options.trailingSlash ?? 'always',
  });
}

const fix = (text: string, findings: Finding[]): string =>
  applyEdits(
    text,
    findings.flatMap((f) => f.edits ?? []),
  ).text;

const summary = (findings: Finding[]) =>
  findings.map((f) => `${f.diagnostic.line}:${f.diagnostic.column} ${f.diagnostic.ruleId}`);

describe('html-lang and document-title (HTML documents)', () => {
  const doc =
    '<!doctype html>\n<html>\n  <head>\n    <meta charset="utf-8">\n  </head>\n  <body><h1>Hello &amp; welcome</h1></body>\n</html>\n';

  it('adds lang and a <title> from the <h1>, after the charset', () => {
    const findings = check('content/doc.html', doc, { kind: 'document' });
    expect(summary(findings)).toEqual(['2:1 html-lang', '3:3 document-title']);
    expect(findings.every((f) => f.diagnostic.fixable)).toBe(true);
    expect(fix(doc, findings)).toBe(
      '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8">\n    <title>Hello &amp; welcome</title>\n  </head>\n  <body><h1>Hello &amp; welcome</h1></body>\n</html>\n',
    );
  });

  it('fills an empty lang attribute and an empty <title>', () => {
    const text = '<!doctype html><html lang=""><head><title> </title></head><body></body></html>';
    const findings = check('content/notes.html', text, { kind: 'document' });
    expect(findings.map((f) => f.diagnostic.message)).toEqual([
      'The <html> element has no lang attribute',
      'Page has an empty <title>',
    ]);
    expect(fix(text, findings)).toBe(
      '<!doctype html><html lang="en"><head><title>Notes</title></head><body></body></html>',
    );
  });

  it('reports a <title> it cannot place without a fix', () => {
    const findings = check('content/bare.html', '<!doctype html><p>Hi', { kind: 'document' });
    expect(findings.map((f) => [f.diagnostic.ruleId, f.diagnostic.fixable])).toEqual([
      ['document-title', false],
    ]);
  });

  it('leaves wrapped HTML fragments to the layout', () => {
    expect(check('content/frag.html', '<p>Hi</p>')).toEqual([]);
  });
});

describe('heading-order (Markdown)', () => {
  it('fixes skipped levels, keeping the relative structure', () => {
    const text = '---\ntitle: T\n---\n\n## A\n\n#### B\n\n##### C\n\n## D\n\n### E\n';
    const findings = check('content/page.md', text);
    expect(summary(findings)).toEqual(['7:1 heading-order', '9:1 heading-order']);
    expect(findings[0]?.diagnostic.message).toBe('Heading level skips from h2 to h4');
    expect(fix(text, findings)).toBe(
      '---\ntitle: T\n---\n\n## A\n\n### B\n\n#### C\n\n## D\n\n### E\n',
    );
  });

  it('accounts for the leading # title and for demoted headings', () => {
    expect(check('content/a.md', '# Title\n\n## Fine\n')).toEqual([]);
    // A second # heading makes the build demote all of them: # → h2, ### → h4.
    const text = '# Title\n\n# One\n\n### Deep\n';
    const findings = check('content/a.md', text);
    expect(findings[0]?.diagnostic.message).toBe('Heading level skips from h2 to h4');
    expect(fix(text, findings)).toBe('# Title\n\n# One\n\n## Deep\n');
  });

  it('cannot fix setext headings but still reports them', () => {
    const findings = check('content/a.md', '---\ntitle: T\n---\nTop\n===\n');
    // A setext h1 after a front-matter title is demoted to h2: no skip.
    expect(findings).toEqual([]);
  });
});

describe('link-trailing-slash', () => {
  it('rewrites Markdown links and definitions to the canonical URL', () => {
    const text =
      'See [about](/about "About us"), [post](../blog/post#top) and [ref].\n\n[ref]: /about?x=1\n';
    const findings = check('content/guides/page.md', text, { url: '/guides/page/' });
    expect(summary(findings)).toEqual([
      '1:5 link-trailing-slash',
      '1:33 link-trailing-slash',
      '3:1 link-trailing-slash',
    ]);
    expect(findings[0]?.diagnostic.message).toBe('Link to /about redirects to /about/');
    expect(findings[0]?.match).toBe('/about');
    expect(fix(text, findings)).toBe(
      'See [about](/about/ "About us"), [post](../blog/post/#top) and [ref].\n\n[ref]: /about/?x=1\n',
    );
  });

  it('rewrites href attributes in HTML sources and in raw HTML in Markdown', () => {
    const html = '<p><a class="x" href="/about">About</a> <a href=/about/>ok</a></p>';
    expect(fix(html, check('content/page.html', html))).toBe(
      '<p><a class="x" href="/about/">About</a> <a href=/about/>ok</a></p>',
    );
    const md = 'Intro\n\n<a href="/about">About</a>\n';
    expect(fix(md, check('content/page.md', md))).toBe('Intro\n\n<a href="/about/">About</a>\n');
  });

  it('removes the slash when trailingSlash is never', () => {
    const pages = { 'content/about.md': '/about' };
    const text = '[a](/about/) [b](/about)\n';
    const findings = check('content/page.md', text, {
      pages,
      url: '/page',
      trailingSlash: 'never',
    });
    expect(fix(text, findings)).toBe('[a](/about) [b](/about)\n');
  });

  it('ignores external links, page sources and links that already match', () => {
    const text = '[a](https://x.test/about) [b](about.md) [c](/about/) [d](#about) [e](/missing)\n';
    expect(check('content/page.md', text)).toEqual([]);
  });

  it('maps positions past front-matter and a BOM back to the file', () => {
    const text = '﻿---\ntitle: T\n---\n[a](/about)\n';
    const [finding] = check('content/page.md', text);
    expect(finding?.diagnostic).toMatchObject({ line: 4, column: 1 });
    expect(fix(text, finding ? [finding] : [])).toBe('﻿---\ntitle: T\n---\n[a](/about/)\n');

    const plain = '﻿[a](/about)\n';
    expect(fix(plain, check('content/page.md', plain))).toBe('﻿[a](/about/)\n');
  });
});
