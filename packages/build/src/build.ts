import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import type { Element, Root } from 'hast';
import { h } from 'hastscript';
import { toHtml } from 'hast-util-to-html';
import {
  type ParsedContent,
  type PreparedSource,
  createReport,
  parseContent,
  prepareSource,
} from '@staticforge/content';
import {
  type Diagnostic,
  type Logger,
  type SforgeConfig,
  countBySeverity,
  sortDiagnostics,
} from '@staticforge/core';
import {
  type PageContext,
  type RenderContext,
  createRenderer,
  loadTheme,
  themeAssetUrl,
} from '@staticforge/render';
import { loadData } from './data.js';
import { navEntries, navFor } from './nav.js';
import {
  PAGE_EXTENSIONS,
  ProjectDirs,
  listFiles,
  resolveOutDir,
  resolveScratchDir,
} from './project.js';
import { type Route, createRefResolver, routeFor } from './routes.js';

export interface BuildOptions {
  rootDir: string;
  config: SforgeConfig;
  /** Include pages marked `draft: true` (overrides build.drafts). */
  drafts?: boolean;
  /** Output directory (overrides build.outDir), relative to rootDir. */
  outDir?: string;
  /**
   * Build into this directory instead, which must be inside the OS temp
   * directory. Used by `sforge dev` so previews never touch build.outDir.
   */
  scratchDir?: string;
  /** Site URL for canonical links (overrides site.baseUrl), e.g. for previews. */
  baseUrl?: string;
  /** Value of `<meta name="generator">`. */
  generator?: string;
  logger?: Logger;
}

export interface BuiltPage {
  /** Project-relative source, or undefined for generated pages. */
  source: string | undefined;
  url: string;
  output: string;
  /** Layout used, or "document" for HTML documents that pass through. */
  layout: string;
}

export interface BuildResult {
  ok: boolean;
  outDir: string;
  pages: BuiltPage[];
  /** Files written, including pages. */
  fileCount: number;
  drafts: { skipped: string[] };
  diagnostics: Diagnostic[];
  summary: Record<'error' | 'warning' | 'info', number>;
  durationMs: number;
}

/** Entry in dist/.sforge/build-manifest.json; deployers diff against it. */
export interface ManifestEntry {
  sha256: string;
  size: number;
}

export const MANIFEST_PATH = '.sforge/build-manifest.json';

interface PageJob {
  prepared: PreparedSource;
  route: Route;
  parsed?: ParsedContent;
}

interface CopyJob {
  source: string;
  output: string;
}

export async function buildSite(options: BuildOptions): Promise<BuildResult> {
  const started = performance.now();
  const { rootDir, config } = options;
  const logger = options.logger;
  const baseUrl = options.baseUrl ?? config.site.baseUrl;
  const includeDrafts = options.drafts ?? config.build.drafts;
  const outDir =
    options.scratchDir !== undefined
      ? resolveScratchDir(options.scratchDir)
      : resolveOutDir(rootDir, options.outDir ?? config.build.outDir);
  const diagnostics: Diagnostic[] = [];

  const theme = loadTheme(config.theme, rootDir);
  const renderer = createRenderer(theme, { rootDir, baseUrl });

  // 1. Claim every output path, reporting collisions.
  const outputs = new Map<string, string>();
  const claim = (output: string, source: string): boolean => {
    const owner = outputs.get(output);
    if (owner !== undefined) {
      diagnostics.push({
        ruleId: 'output-conflict',
        severity: 'error',
        message: `Both ${owner} and ${source} would be written to ${output}`,
        file: source,
      });
      return false;
    }
    outputs.set(output, source);
    return true;
  };

  const pages: PageJob[] = [];
  const copies: CopyJob[] = [];
  const skippedDrafts: string[] = [];
  const contentDir = join(rootDir, ProjectDirs.content);

  for (const file of listFiles(contentDir)) {
    const projectPath = `${ProjectDirs.content}/${file}`;
    const ext = posix.extname(file).toLowerCase();
    if (!PAGE_EXTENSIONS.has(ext)) {
      if (claim(file, projectPath)) copies.push({ source: join(contentDir, file), output: file });
      continue;
    }
    const format = ext === '.md' || ext === '.markdown' ? 'markdown' : 'html';
    const prepared = prepareSource(
      readFileSync(join(contentDir, file), 'utf8'),
      projectPath,
      format,
    );
    if (prepared.meta.draft && !includeDrafts) {
      skippedDrafts.push(projectPath);
      continue;
    }
    const route = routeFor(file, prepared.meta.slug, config.build);
    if (claim(route.output, projectPath)) pages.push({ prepared, route });
  }

  const copyTree = (dir: string, prefix: string, label: string) => {
    for (const file of listFiles(dir)) {
      const output = prefix + file;
      if (claim(output, `${label}/${file}`)) copies.push({ source: join(dir, file), output });
    }
  };
  copyTree(join(rootDir, ProjectDirs.assets), 'assets/', ProjectDirs.assets);
  copyTree(theme.assetsDir, themeAssetUrl('').slice(1), `theme:${theme.manifest.name}`);
  copyTree(join(rootDir, ProjectDirs.static), '', ProjectDirs.static);

  const hasNotFoundPage = outputs.has('404.html');
  if (!hasNotFoundPage && renderer.hasLayout('404')) claim('404.html', 'theme 404 layout');

  // A root-relative URL path exists if it names an output file or directory index.
  const fileExists = (urlPath: string): boolean => {
    let path: string;
    try {
      path = decodeURI(urlPath.split(/[?#]/)[0] ?? '').replace(/^\//, '');
    } catch {
      return false;
    }
    return (
      outputs.has(path) ||
      outputs.has(posix.join(path, 'index.html')) ||
      outputs.has(`${path}.html`)
    );
  };

  // 2. Global styles and scripts: theme first, then the project's.
  const styles = [...theme.manifest.styles.map(themeAssetUrl), ...config.styles];
  const scripts = [...theme.manifest.scripts.map(themeAssetUrl), ...config.scripts];
  for (const url of [...config.styles, ...config.scripts]) {
    if (url.startsWith('/') && !url.startsWith('//') && !fileExists(url)) {
      diagnostics.push({
        ruleId: 'asset-missing',
        severity: 'error',
        message: `Configured stylesheet or script ${url} is not in the built site`,
        hint: 'Put the file under assets/ (served at /assets/) or static/ (served at the site root).',
      });
    }
  }

  // 3. Parse every page; links resolve against the full set of page URLs.
  const pageUrls = new Map(pages.map((p) => [p.prepared.path, p.route.url]));
  for (const page of pages) {
    const report = createReport(page.prepared.path, diagnostics);
    page.parsed = await parseContent(page.prepared, {
      language: config.site.language,
      resolveRef: createRefResolver({ sourcePath: page.prepared.path, pageUrls, report }),
      fileExists,
    });
    diagnostics.push(...page.parsed.diagnostics);
    logger?.debug(`parsed ${page.prepared.path} → ${page.route.url}`);
  }

  // 4. Render and write.
  const nav = navEntries(
    pages.map((p) => ({
      url: p.route.url,
      title: p.parsed?.title ?? '',
      nav: p.prepared.meta.nav,
    })),
  );
  const data = loadData(rootDir, diagnostics);
  const now = new Date();
  const base: Omit<RenderContext, 'page' | 'content' | 'nav'> = {
    site: {
      title: config.site.title,
      description: config.site.description,
      author: config.site.author,
      language: config.site.language,
      baseUrl,
    },
    theme: { styles, scripts },
    data,
    build: {
      generator: options.generator ?? 'staticforge',
      time: now.toISOString(),
      year: now.getUTCFullYear(),
    },
  };

  rmSync(outDir, { recursive: true, force: true });
  const manifest: Record<string, ManifestEntry> = {};
  const write = (output: string, contents: string | Buffer) => {
    const path = join(outDir, output);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
    manifest[output] = {
      sha256: createHash('sha256').update(contents).digest('hex'),
      size: Buffer.byteLength(contents),
    };
  };

  const built: BuiltPage[] = [];
  const renderPage = (
    layout: string,
    page: PageContext,
    content: string,
    source: string | undefined,
  ) => {
    try {
      return renderer.render(layout, { ...base, page, content, nav: navFor(nav, page.url) });
    } catch (error) {
      diagnostics.push({
        ruleId: 'render-failed',
        severity: 'error',
        message: error instanceof Error ? error.message : String(error),
        ...(source !== undefined && { file: source }),
      });
      return undefined;
    }
  };

  for (const { prepared, route, parsed } of pages) {
    if (parsed === undefined) continue;
    if (parsed.kind === 'document') {
      injectHead(parsed.tree, styles, scripts);
      write(route.output, toHtml(parsed.tree));
      built.push({
        source: prepared.path,
        url: route.url,
        output: route.output,
        layout: 'document',
      });
      continue;
    }

    let layout =
      prepared.meta.layout ??
      (route.output === '404.html' && renderer.hasLayout('404')
        ? '404'
        : theme.manifest.defaultLayout);
    if (!renderer.hasLayout(layout)) {
      diagnostics.push({
        ruleId: 'layout-missing',
        severity: 'error',
        message: `Layout "${layout}" does not exist in theme "${theme.manifest.name}"`,
        file: prepared.path,
        line: 1,
      });
      layout = theme.manifest.defaultLayout;
    }

    const html = renderPage(
      layout,
      {
        title: parsed.title,
        description: prepared.meta.description,
        url: route.url,
        absoluteUrl: new URL(route.url, baseUrl).href,
        lang: parsed.lang,
        date: prepared.meta.date,
        updated: prepared.meta.updated,
        tags: prepared.meta.tags,
        layout,
        sourcePath: prepared.path,
        headings: parsed.headings,
        data: prepared.meta,
      },
      toHtml(parsed.tree),
      prepared.path,
    );
    if (html === undefined) continue;
    write(route.output, html);
    built.push({ source: prepared.path, url: route.url, output: route.output, layout });
  }

  if (!hasNotFoundPage && renderer.hasLayout('404')) {
    const html = renderPage(
      '404',
      {
        title: 'Page not found',
        description: undefined,
        url: '/404.html',
        absoluteUrl: new URL('/404.html', baseUrl).href,
        lang: config.site.language,
        date: undefined,
        updated: undefined,
        tags: [],
        layout: '404',
        sourcePath: undefined,
        headings: [],
        data: {},
      },
      '',
      undefined,
    );
    if (html !== undefined) {
      write('404.html', html);
      built.push({ source: undefined, url: '/404.html', output: '404.html', layout: '404' });
    }
  }

  for (const copy of copies) write(copy.output, readFileSync(copy.source));

  const sorted = sortDiagnostics(diagnostics);
  const summary = countBySeverity(sorted);
  write(
    MANIFEST_PATH,
    `${JSON.stringify({ version: 1, generator: base.build.generator, builtAt: base.build.time, baseUrl, files: manifest }, null, 2)}\n`,
  );

  return {
    ok: summary.error === 0,
    outDir,
    pages: built,
    fileCount: Object.keys(manifest).length - 1,
    drafts: { skipped: skippedDrafts },
    diagnostics: sorted,
    summary,
    durationMs: Math.round(performance.now() - started),
  };
}

/** Add theme and site styles/scripts to a pass-through document's <head>. */
function injectHead(tree: Root, styles: string[], scripts: string[]): void {
  const html = tree.children.find(
    (n): n is Element => n.type === 'element' && n.tagName === 'html',
  );
  const head = html?.children.find(
    (n): n is Element => n.type === 'element' && n.tagName === 'head',
  );
  if (head === undefined) return;
  // Insert after leading <meta> elements (charset, viewport) so author styles still win.
  const firstNonMeta = head.children.findIndex(
    (n) => !(n.type === 'element' && n.tagName === 'meta') && n.type !== 'text',
  );
  const at = firstNonMeta === -1 ? head.children.length : firstNonMeta;
  head.children.splice(
    at,
    0,
    ...styles.map((href) => h('link', { rel: 'stylesheet', href })),
    ...scripts.map((src) => h('script', { type: 'module', src })),
  );
}
