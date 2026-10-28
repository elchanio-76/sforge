import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { AxeResults, ImpactValue, RunOptions } from 'axe-core';
import {
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  chromium,
} from 'playwright-core';
import { ErrorCode, type Logger, SforgeError } from '@staticforge/core';
import { startStaticServer } from '@staticforge/server';
import type { CheckPage, Finding } from './types.js';

export type WcagLevel = '2.1-AA' | '2.2-AA' | '2.2-AAA';

export interface HeadlessOptions {
  /** Built site to serve. */
  dir: string;
  pages: CheckPage[];
  trailingSlash: 'always' | 'never';
  wcag: WcagLevel;
  /** Chromium binary to use instead of Playwright's (e.g. a system Chrome). */
  executablePath?: string;
  /** Pages checked in parallel. */
  concurrency?: number;
  timeoutMs?: number;
  logger?: Logger;
}

/** The page is checked once in each of these, so contrast is verified in both color schemes. */
const MODES: { name: string; options: BrowserContextOptions }[] = [
  { name: 'desktop', options: { viewport: { width: 1280, height: 800 }, colorScheme: 'light' } },
  { name: 'dark', options: { viewport: { width: 1280, height: 800 }, colorScheme: 'dark' } },
  {
    name: 'mobile',
    options: {
      viewport: { width: 375, height: 812 },
      colorScheme: 'light',
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    },
  },
];

const TAGS: Record<WcagLevel, string[]> = {
  '2.1-AA': ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
  '2.2-AA': ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
  '2.2-AAA': [
    'wcag2a',
    'wcag2aa',
    'wcag2aaa',
    'wcag21a',
    'wcag21aa',
    'wcag21aaa',
    'wcag22aa',
    'wcag22aaa',
  ],
};

const require = createRequire(import.meta.url);

export const PLAYWRIGHT_VERSION = (require('playwright-core/package.json') as { version: string })
  .version;

/** Command that downloads the browser this version of the checker drives. */
export const INSTALL_BROWSER_COMMAND = `npx playwright-core@${PLAYWRIGHT_VERSION} install --only-shell chromium`;

let axeSource: string | undefined;

/** The parts of the axe global the checker calls inside the page. */
interface AxeGlobal {
  run(context: unknown, options: RunOptions): Promise<AxeResults>;
  getRules(): { tags: string[] }[];
}

/** axe rules that check the same thing as a staticforge rule report under its ID. */
const ALIASES: Record<string, string> = {
  'document-title': 'document-title',
  'frame-title': 'iframe-title',
  'html-has-lang': 'html-lang',
  'image-alt': 'img-alt',
  'meta-viewport': 'meta-viewport',
  'video-caption': 'video-captions',
};

const severityOf = (impact: ImpactValue | undefined): 'error' | 'warning' =>
  impact === 'critical' || impact === 'serious' ? 'error' : 'warning';

const wcagOf = (tags: string[]): string | undefined => {
  for (const tag of tags) {
    const match = /^wcag(\d)(\d)(\d+)$/.exec(tag);
    if (match) return `${match[1]}.${match[2]}.${match[3]}`;
  }
  return undefined;
};

/**
 * "Fix any of the following:\n  Element has insufficient contrast…" → its
 * first reason. The alternatives that follow add length, not information.
 */
const summarize = (summary: string | undefined): string | undefined =>
  (summary ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '' && !/^Fix (any|all) of the following:$/.test(l));

async function launch(executablePath: string | undefined): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true, ...(executablePath && { executablePath }) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Executable doesn't exist|executable.*not found|ENOENT/i.test(message)) {
      throw new SforgeError(
        ErrorCode.BrowserMissing,
        'Chromium is not installed for headless checks',
        {
          hint: `Run \`${INSTALL_BROWSER_COMMAND}\`, set SFORGE_CHROMIUM_PATH to a Chrome/Chromium binary, or pass --no-headless.`,
          cause: error,
        },
      );
    }
    throw error;
  }
}

/**
 * Load each page in headless Chromium and run axe-core: the checks that need
 * layout and computed styles (contrast, target size, focus, reflow).
 */
export async function checkRendered(options: HeadlessOptions): Promise<Finding[]> {
  axeSource ??= readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
  const timeout = options.timeoutMs ?? 30_000;
  const browser = await launch(options.executablePath);
  let server: Awaited<ReturnType<typeof startStaticServer>> | undefined;
  const contexts: { name: string; context: BrowserContext }[] = [];
  try {
    server = await startStaticServer({
      root: () => options.dir,
      host: '127.0.0.1',
      port: 0,
      trailingSlash: options.trailingSlash,
    });
    const baseUrl = server.url;
    const origin = new URL(baseUrl).origin;
    for (const mode of MODES) {
      const context = await browser.newContext({ ...mode.options, reducedMotion: 'reduce' });
      // The pages are the site's own and may come from a pull request: they get no network
      // beyond the local server (no CDN fonts, no localhost services, no cloud metadata).
      await context.route(
        (url) => url.origin !== origin,
        (route) => route.abort('blockedbyclient'),
      );
      contexts.push({ name: mode.name, context });
    }

    const findings: Finding[] = [];
    const queue = [...options.pages];
    const worker = async (): Promise<void> => {
      for (let page = queue.shift(); page !== undefined; page = queue.shift()) {
        options.logger?.debug(`axe: ${page.url}`);
        findings.push(...(await checkPage(page, contexts, baseUrl, options.wcag, timeout)));
      }
    };
    await Promise.all(Array.from({ length: options.concurrency ?? 4 }, worker));
    return findings;
  } finally {
    try {
      await browser.close();
    } finally {
      await server?.close();
    }
  }
}

async function checkPage(
  page: CheckPage,
  contexts: { name: string; context: BrowserContext }[],
  baseUrl: string,
  wcag: WcagLevel,
  timeout: number,
): Promise<Finding[]> {
  const seen = new Map<string, { finding: Finding; modes: string[]; help: string }>();
  const errors = new Map<string, string[]>();

  for (const { name, context } of contexts) {
    const tab = await context.newPage();
    tab.setDefaultTimeout(timeout);
    tab.on('pageerror', (error) => {
      const modes = errors.get(error.message) ?? [];
      errors.set(error.message, [...modes, name]);
    });
    try {
      await tab.goto(baseUrl + page.url, { waitUntil: 'load' });
      await tab.evaluate(axeSource ?? '');
      const results = await tab.evaluate(async (tags: string[]) => {
        const { axe, document } = globalThis as unknown as { axe: AxeGlobal; document: unknown };
        const known = new Set(axe.getRules().flatMap((rule) => rule.tags));
        return axe.run(document, {
          runOnly: { type: 'tag', values: tags.filter((tag) => known.has(tag)) },
          resultTypes: ['violations'],
        });
      }, TAGS[wcag]);
      collect(results, page, name, seen);
    } finally {
      await tab.close();
    }
  }

  const findings: Finding[] = [];
  for (const { finding, modes, help } of seen.values()) {
    const partial = modes.length < contexts.length ? ` (${modes.join(', ')} only)` : '';
    finding.diagnostic.message = help + partial;
    findings.push(finding);
  }
  for (const [message, modes] of errors) {
    const partial = modes.length < contexts.length ? ` (${modes.join(', ')} only)` : '';
    findings.push({
      layer: 'rendered',
      diagnostic: {
        ruleId: 'script-error',
        severity: 'error',
        message: `Uncaught error in page script: ${message}${partial}`,
        ...(page.source !== undefined && { file: page.source }),
        url: page.url,
      },
    });
  }
  return findings;
}

function collect(
  results: AxeResults,
  page: CheckPage,
  mode: string,
  seen: Map<string, { finding: Finding; modes: string[]; help: string }>,
): void {
  for (const violation of results.violations) {
    for (const node of violation.nodes) {
      const selector = node.target
        .map((part) => (Array.isArray(part) ? part.join(' >>> ') : String(part)))
        .join(' ');
      const key = `${violation.id}|${selector}`;
      const existing = seen.get(key);
      if (existing !== undefined) {
        existing.modes.push(mode);
        continue;
      }
      const wcag = wcagOf(violation.tags);
      const hint = summarize(node.failureSummary);
      seen.set(key, {
        modes: [mode],
        help: violation.help,
        finding: {
          layer: 'rendered',
          diagnostic: {
            ruleId: ALIASES[violation.id] ?? `axe/${violation.id}`,
            severity: severityOf(node.impact ?? violation.impact),
            message: violation.help,
            ...(page.source !== undefined && { file: page.source }),
            url: page.url,
            selector,
            ...(wcag !== undefined && { wcag }),
            ...(hint !== undefined && { hint }),
            helpUrl: violation.helpUrl,
          },
        },
      });
    }
  }
}
