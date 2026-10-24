import { chromium } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '@staticforge/core';
import { checkSite } from '../src/index.js';
import { DOCUMENT, config, tempProject } from './helpers.js';

const browserAvailable = await chromium.launch().then(
  async (browser) => {
    await browser.close();
    return true;
  },
  () => false,
);
// CI installs Chromium, so there a missing browser is a failure, not a skip.
if (!browserAvailable && process.env.CI)
  throw new Error('Chromium is required for headless tests in CI');

const exampleDir = new URL('../../../examples/basic-site/', import.meta.url).pathname;
const cliEntry = new URL('../../cli/src/main.ts', import.meta.url).pathname;

describe.skipIf(!browserAvailable)('rendered checks (axe-core in Chromium)', () => {
  it('passes the example site, with the default theme, in light, dark and mobile modes', async () => {
    const { config: exampleConfig, rootDir } = await loadConfig({
      cwd: exampleDir,
      aliases: { staticforge: cliEntry },
    });
    const result = await checkSite({
      rootDir,
      config: exampleConfig,
      headless: true,
      requireBrowser: true,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result).toMatchObject({ ok: true, rendered: 'ran', pages: 8 });
  });

  it('finds contrast problems and says which modes they occur in', async () => {
    const style =
      '<style>.low { color: #777; background: #fff } @media (prefers-color-scheme: dark) { .dark { color: #333; background: #000 } }</style>';
    const rootDir = tempProject({
      'content/index.md': '# Home\n',
      'content/doc.html': DOCUMENT.replace(
        '<title>Doc</title>',
        `<title>Doc</title>${style}`,
      ).replace(
        '<h1>Doc</h1>',
        '<h1>Doc</h1><p class="low">Always low</p><p class="dark">Low in dark mode</p>',
      ),
    });
    const result = await checkSite({
      rootDir,
      config: config(),
      headless: true,
      requireBrowser: true,
    });
    const contrast = result.diagnostics.filter((d) => d.ruleId === 'axe/color-contrast');
    expect(contrast.map((d) => [d.selector, d.message])).toEqual([
      ['.low', 'Elements must meet minimum color contrast ratio thresholds'],
      ['.dark', 'Elements must meet minimum color contrast ratio thresholds (dark only)'],
    ]);
    expect(contrast[0]).toMatchObject({
      severity: 'error',
      wcag: '1.4.3',
      file: 'content/doc.html',
      url: '/doc/',
      hint: expect.stringContaining('insufficient color contrast'),
      helpUrl: expect.stringContaining('dequeuniversity.com'),
    });
  });

  it('reports uncaught script errors', async () => {
    const rootDir = tempProject({
      'content/index.md': '# Home\n',
      'content/doc.html': DOCUMENT.replace(
        '</main>',
        '</main><script>undefinedFunction()</script>',
      ),
    });
    const result = await checkSite({
      rootDir,
      config: config(),
      headless: true,
      requireBrowser: true,
    });
    expect(result.diagnostics).toMatchObject([
      {
        ruleId: 'script-error',
        severity: 'error',
        url: '/doc/',
        message: expect.stringContaining('undefinedFunction is not defined'),
      },
    ]);
  });
});
