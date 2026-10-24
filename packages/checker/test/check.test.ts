import { describe, expect, it } from 'vitest';
import { type Finding, checkSite, dedupe, globToRegExp } from '../src/index.js';
import { DOCUMENT, config, read, tempProject } from './helpers.js';

const STATIC = { headless: false } as const;

const ruleIds = (diagnostics: { ruleId: string }[]) => diagnostics.map((d) => d.ruleId).sort();

describe('checkSite', () => {
  it('passes a clean site built with the default theme', async () => {
    const rootDir = tempProject({
      'content/index.md': '# Home\n\nWelcome. See [about](about.md).\n',
      'content/about.md': '---\ntitle: About\n---\n\n## Team\n\n- [x] Hire\n',
      'content/legacy.html': DOCUMENT,
    });
    const result = await checkSite({ rootDir, config: config(), ...STATIC });
    expect(result.diagnostics).toEqual([]);
    // Three content pages, the generated 404 and the search page.
    expect(result).toMatchObject({ ok: true, pages: 5, rendered: 'off', failOn: 'error' });
  });

  it('reports output problems with the page and element they occur on', async () => {
    const rootDir = tempProject({
      'content/index.md':
        '# Home\n\n[gone](/gone/) [frag](/about/#nope) [ok](/about/#team) [top](#top)\n',
      'content/about.md':
        '---\ntitle: About\n---\n\n## Team\n\n<iframe src="/map.html"></iframe>\n',
      'content/doc.html': DOCUMENT.replace(
        'width=device-width, initial-scale=1',
        'width=device-width, user-scalable=no',
      )
        .replace('<main id="main">', '<div>')
        .replace('</main>', '</div>'),
      'static/map.html': '<!doctype html><title>Map</title>',
    });
    const result = await checkSite({ rootDir, config: config(), ...STATIC });
    expect(ruleIds(result.diagnostics)).toEqual([
      'iframe-title',
      'landmark-main',
      'link-broken',
      'link-fragment',
      'meta-viewport',
    ]);
    const broken = result.diagnostics.find((d) => d.ruleId === 'link-broken');
    expect(broken).toMatchObject({
      severity: 'error',
      file: 'content/index.md',
      url: '/',
      message: 'Link to /gone/ does not match any page or file in the built site',
      selector: expect.stringContaining('a'),
    });
    expect(result.diagnostics.find((d) => d.ruleId === 'meta-viewport')).toMatchObject({
      severity: 'error',
      wcag: '1.4.4',
      file: 'content/doc.html',
    });
    expect(result.ok).toBe(false);
  });

  it('reports html-validate rules under html/ and maps shared ones to staticforge IDs', async () => {
    const rootDir = tempProject({
      'content/index.md': '# Home\n',
      'content/list.html':
        '---\ntitle: List\n---\n<div><li>stray</li></div>\n<h2>A</h2>\n<h4>B</h4>\n',
    });
    const result = await checkSite({ rootDir, config: config(), ...STATIC });
    const list = result.diagnostics.filter((d) => d.url === '/list/');
    expect(ruleIds(list)).toEqual([
      'heading-order',
      'html/element-permitted-content',
      'html/element-permitted-parent',
    ]);
    expect(list.find((d) => d.ruleId === 'heading-order')).toMatchObject({
      wcag: '1.3.1',
      helpUrl: expect.stringContaining('html-validate.org'),
    });
  });

  it('reports a problem once, from the most precise layer', async () => {
    const rootDir = tempProject({
      'content/index.md': '# Home\n\n<video src="/v.mp4" controls></video>\n',
      'static/v.mp4': '',
      'content/doc.html': DOCUMENT.replace('<html lang="en">', '<html>'),
    });
    const result = await checkSite({ rootDir, config: config(), ...STATIC });
    // video-captions: from the build and the output rules; html-lang: source,
    // output rules and html-validate. Each is reported once, at its source line.
    expect(result.diagnostics.map((d) => `${d.ruleId} ${d.file}:${d.line}`)).toEqual([
      'html-lang content/doc.html:2',
      'video-captions content/index.md:3',
    ]);
  });

  it('honours check.ignore (with prefixes), check.failOn and page filters', async () => {
    const rootDir = tempProject({
      'content/index.md': '# Home\n\n[frag](#nope)\n',
      'content/blog/post.md': '# Post\n\n![](missing.png)\n',
    });
    const ignoring = await checkSite({
      rootDir,
      config: config({ check: { ignore: ['link-*', 'img-alt'] } }),
      ...STATIC,
    });
    expect(ignoring.diagnostics).toEqual([]);

    const strict = await checkSite({ rootDir, config: config(), failOn: 'warning', ...STATIC });
    expect(strict.ok).toBe(false);

    const blog = await checkSite({ rootDir, config: config(), pages: ['/blog/**'], ...STATIC });
    expect(blog.pages).toBe(1);
    expect(new Set(blog.diagnostics.map((d) => d.file))).toEqual(new Set(['content/blog/post.md']));
  });

  it('previews fixes as a diff with --dry-run, then applies them', async () => {
    const page = '---\ntitle: Page\n---\n\n## A\n\n#### B\n\n[about](/about)\n';
    const rootDir = tempProject({
      'content/index.md': '# Home\n',
      'content/about.md': '# About\n',
      'content/page.md': page,
    });

    const dry = await checkSite({ rootDir, config: config(), fix: 'dry-run', ...STATIC });
    expect(read(rootDir, 'content/page.md')).toBe(page);
    expect(dry.fixes).toMatchObject({
      applied: false,
      files: [
        { file: 'content/page.md', ruleIds: ['heading-order', 'link-trailing-slash'], edits: 2 },
      ],
    });
    expect(dry.fixes?.diff).toContain('-#### B\n+### B');
    expect(dry.fixes?.diff).toContain('+[about](/about/)');

    const applied = await checkSite({ rootDir, config: config(), fix: 'apply', ...STATIC });
    expect(applied.fixes).toMatchObject({ applied: true, files: [{ file: 'content/page.md' }] });
    expect(read(rootDir, 'content/page.md')).toBe(
      '---\ntitle: Page\n---\n\n## A\n\n### B\n\n[about](/about/)\n',
    );
    expect(applied.diagnostics).toEqual([]);
  });

  it('skips rendered checks with a warning when Chromium is missing, unless required', async () => {
    const rootDir = tempProject({ 'content/index.md': '# Home\n' });
    const options = {
      rootDir,
      config: config(),
      headless: true,
      executablePath: '/nonexistent/chromium',
    };
    const skipped = await checkSite(options);
    expect(skipped.rendered).toBe('skipped');
    expect(skipped.diagnostics).toMatchObject([
      {
        ruleId: 'headless-skipped',
        severity: 'warning',
        hint: expect.stringContaining('playwright-core@'),
      },
    ]);
    await expect(checkSite({ ...options, requireBrowser: true })).rejects.toMatchObject({
      code: 'SF_BROWSER_MISSING',
    });
  });
});

describe('dedupe', () => {
  const finding = (
    layer: Finding['layer'],
    ruleId: string,
    extra: Partial<Finding> = {},
  ): Finding => ({
    layer,
    diagnostic: { ruleId, severity: 'error', message: '', file: 'content/a.md', url: '/a/' },
    ...extra,
  });

  it('matches link findings by target, and page-level rules by page', () => {
    const kept = dedupe([
      finding('source', 'link-trailing-slash', { match: '/x' }),
      finding('output', 'link-trailing-slash', { match: '/x' }),
      finding('output', 'link-trailing-slash', { match: '/y' }),
      finding('build', 'img-alt'),
      finding('output', 'img-alt'),
      finding('rendered', 'img-alt'),
    ]);
    expect(kept.map((f) => `${f.layer} ${f.diagnostic.ruleId} ${f.match ?? ''}`)).toEqual([
      'source link-trailing-slash /x',
      'output link-trailing-slash /y',
      'build img-alt ',
    ]);
  });
});

describe('globToRegExp', () => {
  it('matches URL and path globs', () => {
    expect(globToRegExp('/blog/**').test('/blog/a/b/')).toBe(true);
    expect(globToRegExp('/blog/*').test('/blog/a/b/')).toBe(false);
    expect(globToRegExp('content/*.md').test('content/a.md')).toBe(true);
    expect(globToRegExp('/a.html').test('/aXhtml')).toBe(false);
  });
});
