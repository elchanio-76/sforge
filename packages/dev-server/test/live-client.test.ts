import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Browser, type Page, chromium } from 'playwright-core';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@staticforge/core';
import { type DevServer, startDevServer } from '../src/index.js';
import { tempDir } from './helpers.js';

const browserAvailable = await chromium.launch().then(
  async (browser) => {
    await browser.close();
    return true;
  },
  () => false,
);
// CI installs Chromium, so there a missing browser is a failure, not a skip.
if (!browserAvailable && process.env.CI)
  throw new Error('Chromium is required for browser tests in CI');

const config = {
  site: { title: 'Live', baseUrl: 'https://example.com' },
  styles: ['/assets/css/site.css'],
  search: { enabled: false },
};
const home = (body: string) => `---\ntitle: Home\n---\n\n${body}\n`;

let server: DevServer | undefined;
let browser: Browser | undefined;
afterEach(async () => {
  await browser?.close();
  await server?.close();
  browser = server = undefined;
});

/** Resolves on the page's next load (the client reloads by navigating). */
const nextLoad = (page: Page) => page.waitForEvent('load', { timeout: 10_000 });

describe.skipIf(!browserAvailable)(
  'the live-reload client in a browser',
  { timeout: 60_000 },
  () => {
    it('reloads on changes, swaps stylesheets in place and shows build problems', async () => {
      const rootDir = tempDir({
        'staticforge.config.json': JSON.stringify(config),
        'content/index.md': home('First version.'),
        'assets/css/site.css': 'main { color: rgb(0, 0, 0); }\n',
        'content/photo.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>',
      });
      const write = (path: string, text: string) => writeFileSync(join(rootDir, path), text);
      server = await startDevServer({
        loadConfig: () => loadConfig({ cwd: rootDir }),
        host: '127.0.0.1',
        port: 0,
        debounceMs: 20,
      });
      browser = await chromium.launch();
      const page = await browser.newPage();
      const connected = page.waitForResponse((r) => r.url().endsWith('/__sforge/events'));
      await page.goto(`${server.url}/`);
      await connected;
      await expect.poll(() => page.textContent('main')).toContain('First version.');
      const overlay = page.locator('sforge-overlay');
      expect(await overlay.count()).toBe(0);

      // Content: the page reloads with the new text.
      let loaded = nextLoad(page);
      write('content/index.md', home('Second version.'));
      await loaded;
      await expect.poll(() => page.textContent('main')).toContain('Second version.');

      // Stylesheet: swapped without a reload.
      let reloads = 0;
      const count = () => reloads++;
      page.on('load', count);
      write('assets/css/site.css', 'main { color: rgb(200, 0, 0); }\n');
      await expect
        .poll(() => page.evaluate(() => getComputedStyle(document.querySelector('main')!).color))
        .toBe('rgb(200, 0, 0)');
      expect(await page.getAttribute('link[href*="/assets/css/site.css"]', 'href')).toContain(
        'sforge=',
      );
      expect(reloads).toBe(0);
      page.off('load', count);

      // A problem: the overlay lists it, and its toggle works from the keyboard.
      loaded = nextLoad(page);
      write('content/index.md', home('Second version.\n\n<img src="photo.svg">'));
      await loaded;
      const toggle = overlay.getByRole('button');
      await expect.poll(() => toggle.textContent()).toMatch(/^[1-9]\d* errors?, \d+ warnings?$/);
      expect(await overlay.getByRole('listitem').allTextContents()).toEqual(
        expect.arrayContaining([expect.stringContaining('img-alt')]),
      );
      expect(await toggle.getAttribute('aria-expanded')).toBe('true');
      await toggle.focus();
      await page.keyboard.press('Enter');
      expect(await toggle.getAttribute('aria-expanded')).toBe('false');
      expect(await overlay.getByRole('list').isHidden()).toBe(true);

      // Fixed: the overlay goes away.
      loaded = nextLoad(page);
      write('content/index.md', home('Second version.\n\n<img src="photo.svg" alt="A photo">'));
      await loaded;
      await expect.poll(() => overlay.count()).toBe(0);

      // A broken config: the last good build is still served, with the error in the overlay.
      loaded = nextLoad(page);
      write('staticforge.config.json', '{ "site": ');
      await loaded;
      await expect
        .poll(() => overlay.getByRole('listitem').allTextContents())
        .toEqual([expect.stringContaining('SF_CONFIG_LOAD_FAILED')]);
      await expect.poll(() => page.textContent('main')).toContain('Second version.');

      loaded = nextLoad(page);
      write('staticforge.config.json', JSON.stringify(config));
      await loaded;
      await expect.poll(() => overlay.count()).toBe(0);
    });
  },
);
