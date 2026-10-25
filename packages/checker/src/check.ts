import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { fromHtml } from 'hast-util-from-html';
import type { Root } from 'hast';
import {
  type BuildResult,
  MANIFEST_PATH,
  buildSite,
  hashOf,
  memoized,
  stableJson,
} from '@staticforge/build';
import type { CheckCache } from './cache.js';
import {
  type Diagnostic,
  ErrorCode,
  type Logger,
  type SforgeConfig,
  SforgeError,
  type WorkerPool,
  countBySeverity,
  createWorkerPool,
  mapInPool,
  poolSize,
  sortDiagnostics,
} from '@staticforge/core';
import { INSTALL_BROWSER_COMMAND, checkRendered } from './headless.js';
import { checkOutput, idsOf } from './output-rules.js';
import { pageUrlMap } from './source-rules.js';
import {
  MIN_PAGES_FOR_WORKERS,
  SOURCE_TASK,
  type SourceItem,
  VALIDATE_TASK,
  checkSources,
  validatePages,
} from './tasks.js';
import { type TextEdit, applyEdits } from './text.js';
import type { CheckPage, Finding } from './types.js';

export interface CheckBuildOptions {
  rootDir: string;
  config: SforgeConfig;
  /** A finished build of the project. */
  build: BuildResult;
  /** Run rendered checks in headless Chromium. */
  headless: boolean;
  /**
   * Fail with SF_BROWSER_MISSING when Chromium is unavailable. Otherwise the
   * rendered checks are skipped with a warning.
   */
  requireBrowser?: boolean;
  /** Chromium binary to use instead of Playwright's. */
  executablePath?: string;
  /** Only check built pages whose URL or source path matches one of these globs. */
  pages?: string[];
  logger?: Logger;
  /** Worker threads for the per-page rules; without one, the check starts its own when worthwhile. */
  pool?: WorkerPool;
  /** Results of earlier checks of the same project to reuse (`sforge dev`). */
  cache?: CheckCache;
}

export interface CheckBuildResult {
  /** Findings of every layer, before de-duplication. */
  findings: Finding[];
  /** Built pages checked by the output (and rendered) rules. */
  pages: number;
  /** `skipped` when headless checks were requested but Chromium was unavailable. */
  rendered: 'ran' | 'skipped' | 'off';
}

export interface CheckOptions extends Omit<CheckBuildOptions, 'build' | 'headless'> {
  /** Run rendered checks in headless Chromium (default: check.headless). */
  headless?: boolean;
  /** Include draft pages (overrides build.drafts). */
  drafts?: boolean;
  /** Apply fixes to the sources, or only compute them as a diff. */
  fix?: 'apply' | 'dry-run';
  failOn?: 'error' | 'warning';
  generator?: string;
}

export interface FixedFile {
  /** Project-relative path. */
  file: string;
  ruleIds: string[];
  edits: number;
}

export interface CheckResult {
  ok: boolean;
  failOn: 'error' | 'warning';
  pages: number;
  rendered: CheckBuildResult['rendered'];
  diagnostics: Diagnostic[];
  summary: Record<'error' | 'warning' | 'info', number>;
  fixes?: {
    applied: boolean;
    files: FixedFile[];
    /** Unified diff of the fixes. */
    diff: string;
  };
  durationMs: number;
}

/**
 * Rules checked completely by more than one layer: on a page, findings from
 * the most precise layer replace the others.
 */
const ONE_PER_PAGE = new Set([
  'document-title',
  'heading-order',
  'html-lang',
  'iframe-title',
  'img-alt',
  'meta-viewport',
  'video-captions',
]);

/**
 * Hash of what output rules see of the whole site: its files and every page's
 * ids. Undefined (no caching) when the build has no manifest to list its files.
 */
function siteKeyOf(
  outDir: string,
  ids: Map<string, Set<string>>,
  trailingSlash: string,
): string | undefined {
  let files: unknown;
  try {
    files = (JSON.parse(readFileSync(join(outDir, MANIFEST_PATH), 'utf8')) as { files: unknown })
      .files;
  } catch {
    return undefined;
  }
  return hashOf(stableJson(Object.keys(files as object).sort()), stableJson(ids), trailingSlash);
}

/** Most precise first: source positions beat output selectors beat rendered ones. */
const PRECISION: Record<Finding['layer'], number> = { source: 0, build: 1, output: 2, rendered: 3 };

/** `/blog/**` matches every page under /blog/; `content/docs/*.md` a set of sources. */
export function globToRegExp(glob: string): RegExp {
  let pattern = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i] as string;
    if (char === '*') {
      if (glob[i + 1] === '*') {
        pattern += '.*';
        i++;
      } else {
        pattern += '[^/]*';
      }
    } else if (char === '?') {
      pattern += '[^/]';
    } else {
      pattern += char.replace(/[\\^$.+()|{}[\]]/g, '\\$&');
    }
  }
  return new RegExp(`^${pattern}$`);
}

const ignored = (ruleId: string, patterns: string[]): boolean =>
  patterns.some((p) => (p.endsWith('*') ? ruleId.startsWith(p.slice(0, -1)) : ruleId === p));

/**
 * Drop findings that a more precise layer already reports: the same rule on
 * the same page and, for rules that identify their target (links), the same target.
 */
export function dedupe(findings: Finding[]): Finding[] {
  // Candidates by rule and page (file or URL), so the lookup stays linear.
  const index = new Map<string, Finding[]>();
  const keysOf = (f: Finding): string[] =>
    [
      f.diagnostic.file !== undefined ? `f\u0000${f.diagnostic.file}` : undefined,
      f.diagnostic.url !== undefined ? `u\u0000${f.diagnostic.url}` : undefined,
    ]
      .filter((k) => k !== undefined)
      .map((k) => `${f.diagnostic.ruleId}\u0000${k}`);
  for (const f of findings) {
    for (const k of keysOf(f)) index.set(k, [...(index.get(k) ?? []), f]);
  }
  return findings.filter(
    (f) =>
      !keysOf(f).some((k) =>
        (index.get(k) ?? []).some(
          (other) =>
            PRECISION[other.layer] < PRECISION[f.layer] &&
            (ONE_PER_PAGE.has(f.diagnostic.ruleId) ||
              (other.match !== undefined && other.match === f.match)),
        ),
      ),
  );
}

/** De-duplicate, drop ignored rules (`check.ignore`, `axe/*` style prefixes allowed) and sort. */
export function finalizeDiagnostics(findings: Finding[], ignore: string[]): Diagnostic[] {
  return sortDiagnostics(
    dedupe(findings)
      .map((f) => f.diagnostic)
      .filter((d) => !ignored(d.ruleId, ignore)),
  );
}

/** Check a finished build: its own diagnostics plus the source, output and rendered rules. */
export async function checkBuild(options: CheckBuildOptions): Promise<CheckBuildResult> {
  if (options.pool !== undefined) return check(options, options.pool);
  // Workers start on first use, so a small site never pays for them.
  const size = poolSize(options.config.build.workers);
  const pool = size > 0 ? createWorkerPool(size) : undefined;
  try {
    return await check(options, pool);
  } finally {
    await pool?.close();
  }
}

async function check(
  options: CheckBuildOptions,
  pool: WorkerPool | undefined,
): Promise<CheckBuildResult> {
  const { rootDir, config, build, logger, cache } = options;
  cache?.begin();
  const findings: Finding[] = build.diagnostics.map((diagnostic) => ({
    layer: 'build',
    diagnostic,
  }));

  const pages: CheckPage[] = build.pages.map((p) => ({
    url: p.url,
    source: p.source,
    output: p.output,
    kind: p.source === undefined ? 'generated' : p.layout === 'document' ? 'document' : 'fragment',
  }));
  const pageUrls = pageUrlMap(pages);

  // Source rules (in workers for large sites).
  const sourceItems = pages.flatMap((page): SourceItem[] =>
    page.source === undefined
      ? []
      : [
          {
            page: { ...page, source: page.source },
            text: readFileSync(join(rootDir, page.source), 'utf8'),
          },
        ],
  );
  const sourceContext = {
    language: config.site.language,
    pageUrls,
    trailingSlash: config.build.trailingSlash,
  };
  const sourceKey = cache && hashOf(stableJson(sourceContext));
  const sourceFindings = await memoized(
    sourceItems,
    cache?.sources,
    (item) => hashOf(sourceKey ?? '', stableJson(item.page), item.text),
    (missing) =>
      mapInPool(pool, SOURCE_TASK, missing, sourceContext, checkSources, {
        minItems: MIN_PAGES_FOR_WORKERS,
      }),
    () => true,
  );
  if (cache) cache.stats.sources = sourceFindings.computed;
  findings.push(...sourceFindings.results.flat());

  // Output rules. Links can point at fragment ids on any page, so every page's ids are needed.
  const htmls = new Map<string, string>();
  const trees = new Map<string, Root>();
  const treeOf = (output: string): Root => {
    let tree = trees.get(output);
    if (tree === undefined) {
      tree = fromHtml(htmls.get(output) ?? '');
      trees.set(output, tree);
    }
    return tree;
  };
  const ids = new Map<string, Set<string>>();
  for (const page of pages) {
    const html = readFileSync(join(build.outDir, page.output), 'utf8');
    htmls.set(page.output, html);
    const key = cache && hashOf(html);
    let pageIds = key === undefined ? undefined : cache?.ids.get(key);
    if (pageIds === undefined) {
      pageIds = idsOf(treeOf(page.output));
      if (key !== undefined) cache?.ids.set(key, pageIds);
    }
    ids.set(page.output, pageIds);
  }
  const filters = (options.pages ?? []).map(globToRegExp);
  const selected = pages.filter(
    (p) =>
      filters.length === 0 ||
      filters.some((re) => re.test(p.url) || (p.source !== undefined && re.test(p.source))),
  );
  // The search index may still be being written (`sforge dev` defers it).
  const exists = (path: string): boolean => {
    if (config.search.enabled && path.startsWith('pagefind/')) return true;
    const full = join(build.outDir, path);
    return existsSync(full) && statSync(full).isFile();
  };
  const pageKey = (page: CheckPage) => stableJson(page) + hashOf(htmls.get(page.output) ?? '');

  // html-validate (in workers for large sites).
  const validated = await memoized(
    selected,
    cache?.validated,
    (page) => hashOf(pageKey(page)),
    (missing) =>
      mapInPool(
        pool,
        VALIDATE_TASK,
        missing.map((page) => ({ page, html: htmls.get(page.output) ?? '' })),
        undefined,
        validatePages,
        { minItems: MIN_PAGES_FOR_WORKERS },
      ),
    () => true,
  );
  if (cache) cache.stats.validated = validated.computed;

  // staticforge's output rules, here: they need every page's ids. Their results
  // depend on the files and ids of the whole site.
  const siteKey = cache && siteKeyOf(build.outDir, ids, config.build.trailingSlash);
  const output = await memoized(
    selected,
    siteKey === undefined ? undefined : cache?.output,
    (page) => hashOf(siteKey ?? '', pageKey(page)),
    async (missing) =>
      missing.map((page) =>
        checkOutput({
          page,
          tree: treeOf(page.output),
          exists,
          idsOf: (target) => ids.get(target),
          trailingSlash: config.build.trailingSlash,
        }),
      ),
    () => true,
  );
  if (cache) cache.stats.output = output.computed;
  for (const [i] of selected.entries()) {
    findings.push(...(output.results[i] ?? []), ...(validated.results[i] ?? []));
  }
  cache?.commit();

  // Rendered rules.
  let rendered: CheckBuildResult['rendered'] = 'off';
  if (options.headless && selected.length > 0) {
    try {
      findings.push(
        ...(await checkRendered({
          dir: build.outDir,
          pages: selected,
          trailingSlash: config.build.trailingSlash,
          wcag: config.check.wcag,
          ...(options.executablePath !== undefined && { executablePath: options.executablePath }),
          ...(logger && { logger }),
        })),
      );
      rendered = 'ran';
    } catch (error) {
      if (!(error instanceof SforgeError) || error.code !== ErrorCode.BrowserMissing) throw error;
      if (options.requireBrowser) throw error;
      rendered = 'skipped';
      findings.push({
        layer: 'rendered',
        diagnostic: {
          ruleId: 'headless-skipped',
          severity: 'warning',
          message:
            'Rendered checks (contrast, target size, focus) were skipped: Chromium is not installed',
          hint: `Run \`${INSTALL_BROWSER_COMMAND}\`, or set check.headless to false.`,
        },
      });
    }
  }
  if (filters.length === 0) return { findings, pages: selected.length, rendered };

  // Drop build and source findings that belong to pages outside the selection.
  const unselected = pages.filter((p) => !selected.includes(p));
  const urls = new Set(unselected.map((p) => p.url));
  const sources = new Set(unselected.flatMap((p) => (p.source === undefined ? [] : [p.source])));
  return {
    findings: findings.filter(
      ({ diagnostic: d }) =>
        !(d.url !== undefined && urls.has(d.url)) && !(d.file !== undefined && sources.has(d.file)),
    ),
    pages: selected.length,
    rendered,
  };
}

async function buildAndCheck(options: CheckOptions, headless: boolean): Promise<CheckBuildResult> {
  const scratch = mkdtempSync(join(tmpdir(), 'sforge-check-'));
  try {
    const build = await buildSite({
      rootDir: options.rootDir,
      config: options.config,
      scratchDir: scratch,
      ...(options.pool && { pool: options.pool }),
      ...(options.drafts !== undefined && { drafts: options.drafts }),
      ...(options.generator !== undefined && { generator: options.generator }),
      ...(options.logger && { logger: options.logger }),
    });
    return await checkBuild({ ...options, build, headless });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function collectFixes(
  rootDir: string,
  findings: Finding[],
): { files: FixedFile[]; diff: string; write: () => void } {
  const byFile = new Map<string, { edits: TextEdit[]; ruleIds: Set<string> }>();
  for (const f of findings) {
    if (f.edits === undefined || f.diagnostic.file === undefined) continue;
    const entry = byFile.get(f.diagnostic.file) ?? { edits: [], ruleIds: new Set() };
    entry.edits.push(...f.edits);
    entry.ruleIds.add(f.diagnostic.ruleId);
    byFile.set(f.diagnostic.file, entry);
  }

  const files: FixedFile[] = [];
  const writes: { path: string; text: string }[] = [];
  let diff = '';
  for (const [file, { edits, ruleIds }] of [...byFile].sort(([a], [b]) => a.localeCompare(b))) {
    const path = join(rootDir, file);
    const before = readFileSync(path, 'utf8');
    const { text, skipped } = applyEdits(before, edits);
    if (text === before) continue;
    files.push({ file, ruleIds: [...ruleIds].sort(), edits: edits.length - skipped.length });
    writes.push({ path, text });
    diff += createTwoFilesPatch(`a/${file}`, `b/${file}`, before, text, '', '', { context: 3 });
  }
  return {
    files,
    diff,
    write: () => {
      for (const { path, text } of writes) writeFileSync(path, text);
    },
  };
}

/** Build the site into a temporary directory and check it, optionally fixing what it safely can. */
export async function checkSite(options: CheckOptions): Promise<CheckResult> {
  if (options.pool !== undefined) return checkSiteWith(options);
  // One pool for every build and check of the run (a fix runs both twice).
  const size = poolSize(options.config.build.workers);
  const pool = size > 0 ? createWorkerPool(size) : undefined;
  try {
    return await checkSiteWith({ ...options, ...(pool && { pool }) });
  } finally {
    await pool?.close();
  }
}

async function checkSiteWith(options: CheckOptions): Promise<CheckResult> {
  const started = performance.now();
  const { config } = options;
  const headless = options.headless ?? config.check.headless;
  const failOn = options.failOn ?? config.check.failOn;

  let fixes: CheckResult['fixes'];
  if (options.fix === 'apply') {
    // Fixes come from source rules, so the first pass needs no browser.
    const first = await buildAndCheck(options, false);
    const collected = collectFixes(options.rootDir, first.findings);
    collected.write();
    fixes = { applied: true, files: collected.files, diff: collected.diff };
  }

  const result = await buildAndCheck(options, headless);
  if (options.fix === 'dry-run') {
    const collected = collectFixes(options.rootDir, result.findings);
    fixes = { applied: false, files: collected.files, diff: collected.diff };
  }

  const diagnostics = finalizeDiagnostics(result.findings, config.check.ignore);
  const summary = countBySeverity(diagnostics);
  return {
    ok: failOn === 'error' ? summary.error === 0 : summary.error + summary.warning === 0,
    failOn,
    pages: result.pages,
    rendered: result.rendered,
    diagnostics,
    summary,
    ...(fixes && { fixes }),
    durationMs: Math.round(performance.now() - started),
  };
}
