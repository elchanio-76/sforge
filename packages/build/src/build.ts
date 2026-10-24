import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import type { Element, Root } from 'hast';
import { h } from 'hastscript';
import { toHtml } from 'hast-util-to-html';
import { type SearchPage, writeSearchIndex } from '@staticforge/assets';
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
  type FeedLink,
  type PageContext,
  type PageSummary,
  type Pagination,
  type RenderContext,
  type TagSummary,
  createRenderer,
  loadTheme,
  themeAssetUrl,
} from '@staticforge/render';
import { type CodeInput, isCode, processCode } from './code-assets.js';
import { loadData } from './data.js';
import { absolutizeHtml, atomFeed, FEED_ITEMS, robotsTxt, rssFeed, sitemapXml } from './feeds.js';
import { finishFragment, finishHtml, finishTree } from './html.js';
import { type ImageCache, optimizeImages } from './images.js';
import { navEntries, navFor } from './nav.js';
import {
  PAGE_EXTENSIONS,
  ProjectDirs,
  listFiles,
  resolveOutDir,
  resolveScratchDir,
} from './project.js';
import { type Route, createRefResolver, routeFor } from './routes.js';
import {
  type SitePage,
  breadcrumbsFor,
  collectionsOf,
  listRoute,
  slugify,
  summarize,
  tagRoute,
  tagsOf,
} from './site.js';

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
  /** Minify HTML, CSS and JS (overrides build.minify). */
  minify?: boolean;
  /**
   * Reference stylesheets and scripts by content-hashed names (default true).
   * `sforge dev` turns it off so swapped stylesheets keep their URLs.
   */
  fingerprint?: boolean;
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
  /**
   * `immutable`: the name changes with the contents (fingerprinted assets,
   * image variants), so it can be cached forever. `revalidate`: everything else.
   */
  cache: 'immutable' | 'revalidate';
}

export const MANIFEST_PATH = '.sforge/build-manifest.json';

/** Encoded image variants, kept between builds. */
export const CACHE_DIR = '.sforge/cache';

interface PageJob {
  prepared: PreparedSource;
  route: Route;
  parsed?: ParsedContent;
}

interface CopyJob {
  source: string;
  output: string;
}

/** A page to render with a layout: from content, or generated (list, tag, search, 404). */
interface RenderJob {
  route: Route;
  layout: string;
  page: PageContext;
  content: string;
  source: string | undefined;
  pagination?: Pagination;
  tag?: TagSummary & { items: PageSummary[] };
}

const ucfirst = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export async function buildSite(options: BuildOptions): Promise<BuildResult> {
  const started = performance.now();
  const { rootDir, config } = options;
  const logger = options.logger;
  const baseUrl = options.baseUrl ?? config.site.baseUrl;
  const includeDrafts = options.drafts ?? config.build.drafts;
  const minify = options.minify ?? config.build.minify;
  const fingerprint = options.fingerprint ?? true;
  const urlOptions = config.build;
  const outDir =
    options.scratchDir !== undefined
      ? resolveScratchDir(options.scratchDir)
      : resolveOutDir(rootDir, options.outDir ?? config.build.outDir);
  const diagnostics: Diagnostic[] = [];

  const theme = loadTheme(config.theme, rootDir);

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
    const route = routeFor(file, prepared.meta.slug, urlOptions);
    if (claim(route.output, projectPath)) pages.push({ prepared, route });
  }

  const codeInputs: CodeInput[] = [];
  const copyTree = (dir: string, prefix: string, label: string, processed: boolean) => {
    for (const file of listFiles(dir)) {
      const output = prefix + file;
      if (!claim(output, `${label}/${file}`)) continue;
      if (processed && isCode(file)) {
        codeInputs.push({ source: join(dir, file), output, label: `${label}/${file}` });
      } else {
        copies.push({ source: join(dir, file), output });
      }
    }
  };
  copyTree(join(rootDir, ProjectDirs.assets), 'assets/', ProjectDirs.assets, true);
  copyTree(theme.assetsDir, themeAssetUrl('').slice(1), `theme:${theme.manifest.name}`, true);
  copyTree(join(rootDir, ProjectDirs.static), '', ProjectDirs.static, false);
  const copyByOutput = new Map(copies.map((c) => [c.output, c]));

  // 2. Stylesheets and scripts: bundle, minify, fingerprint.
  const code = await processCode(codeInputs, { minify, fingerprint });
  diagnostics.push(...code.diagnostics);
  for (const out of code.outputs) {
    if (!outputs.has(out.output)) claim(out.output, 'assets');
  }
  const assetUrl = (url: string): string => {
    const [, path = url, rest = ''] = /^([^?#]*)(.*)$/s.exec(url) ?? [];
    return (code.urls.get(path) ?? path) + rest;
  };
  const renderer = createRenderer(theme, { rootDir, baseUrl, assetUrl });

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

  // Global styles and scripts: theme first, then the project's.
  const styles = [...theme.manifest.styles.map(themeAssetUrl), ...config.styles].map(assetUrl);
  const scripts = [...theme.manifest.scripts.map(themeAssetUrl), ...config.scripts].map(assetUrl);
  for (const url of [...config.styles, ...config.scripts]) {
    if (url.startsWith('/') && !url.startsWith('//') && !code.urls.has(url) && !fileExists(url)) {
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
  const imageOutputs = new Map<string, string>();
  const imageCache: ImageCache = new Map();
  for (const page of pages) {
    const report = createReport(page.prepared.path, diagnostics);
    page.parsed = await parseContent(page.prepared, {
      language: config.site.language,
      resolveRef: createRefResolver({ sourcePath: page.prepared.path, pageUrls, report }),
      fileExists,
    });
    diagnostics.push(...page.parsed.diagnostics);

    if (config.images.optimize && page.parsed.kind === 'fragment') {
      await optimizeImages(
        page.parsed.tree,
        {
          ...config.images,
          cacheDir: join(rootDir, CACHE_DIR, 'images'),
          sourceOf: (urlPath) => {
            try {
              return copyByOutput.get(decodeURI(urlPath).slice(1))?.source;
            } catch {
              return undefined;
            }
          },
          emit: (output, file) => {
            if (!imageOutputs.has(output) && claim(output, 'images'))
              imageOutputs.set(output, file);
          },
          fail: (node, message) =>
            report(
              {
                ruleId: 'image-failed',
                severity: 'warning',
                message: `Image could not be optimized and is used as is: ${message}`,
              },
              node,
            ),
        },
        imageCache,
      );
    }
    logger?.debug(`parsed ${page.prepared.path} → ${page.route.url}`);
  }

  // 4. Site features: collections, tags, feeds.
  const sitePages: SitePage[] = pages.flatMap(({ prepared, route, parsed }) =>
    parsed === undefined || parsed.kind === 'document'
      ? []
      : [{ source: prepared.path, url: route.url, title: parsed.title, meta: prepared.meta }],
  );
  const hasTagPages = renderer.hasLayout('tag');
  const tagUrl = (slug: string) => (hasTagPages ? tagRoute(slug, urlOptions).url : undefined);
  const summaries = new Map(sitePages.map((p) => [p.source, summarize(p, baseUrl, tagUrl)]));

  const { collections, problems } = collectionsOf(config.collections, sitePages);
  for (const message of problems) {
    diagnostics.push({ ruleId: 'collection-invalid', severity: 'error', message });
  }
  const memberOf = new Map<string, string>();
  for (const c of collections)
    for (const p of c.pages) if (!memberOf.has(p.source)) memberOf.set(p.source, c.name);

  const tagged = new Map<string, { name: string; pages: SitePage[] }>();
  for (const page of sitePages) {
    for (const name of page.meta.tags) {
      const slug = slugify(name);
      const entry = tagged.get(slug) ?? { name, pages: [] };
      entry.pages.push(page);
      tagged.set(slug, entry);
    }
  }
  const tags: TagSummary[] = [...tagged]
    .map(([slug, { name, pages: tagPages }]) => ({
      name,
      slug,
      url: tagUrl(slug),
      count: tagPages.length,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const titleOf = (c: (typeof collections)[number]) =>
    sitePages.find((p) => p.source === c.index)?.title ?? ucfirst(c.name);
  const feeds: FeedLink[] = [];
  const feedJobs: {
    output: string;
    url: string;
    kind: 'rss' | 'atom';
    collection: (typeof collections)[number];
  }[] = [];
  for (const c of collections) {
    const base = c.dir === '' ? '' : `${c.dir}/`;
    for (const kind of ['rss', 'atom'] as const) {
      if (!c.feed[kind]) continue;
      const output = `${base}${kind === 'rss' ? 'feed.xml' : 'atom.xml'}`;
      if (!claim(output, `collection ${c.name}`)) continue;
      const url = `/${encodeURI(output)}`;
      feeds.push({
        type: kind === 'rss' ? 'application/rss+xml' : 'application/atom+xml',
        title: `${config.site.title}: ${titleOf(c)} (${kind === 'rss' ? 'RSS' : 'Atom'})`,
        url,
      });
      feedJobs.push({ output, url, kind, collection: c });
    }
  }

  // 5. Render jobs.
  const pageContext = (
    fields: Partial<Omit<PageContext, 'tagLinks'>> & Pick<PageContext, 'title' | 'url' | 'layout'>,
  ): PageContext => ({
    description: undefined,
    absoluteUrl: new URL(fields.url, baseUrl).href,
    lang: config.site.language,
    date: undefined,
    updated: undefined,
    tags: [],
    sourcePath: undefined,
    headings: [],
    data: {},
    ...fields,
    tagLinks: tagsOf(fields.tags ?? [], tagUrl),
  });
  const jobs: RenderJob[] = [];
  const documents: PageJob[] = [];
  const indexJobs = new Map<string, RenderJob>();
  for (const job of pages) {
    const { prepared, route, parsed } = job;
    if (parsed === undefined) continue;
    if (parsed.kind === 'document') {
      documents.push(job);
      continue;
    }
    const collection = memberOf.get(prepared.path);
    const isIndexOf = collections.find((c) => c.index === prepared.path);
    let layout =
      prepared.meta.layout ??
      (route.output === '404.html' && renderer.hasLayout('404')
        ? '404'
        : collection !== undefined && renderer.hasLayout('post')
          ? 'post'
          : isIndexOf !== undefined && renderer.hasLayout('list')
            ? 'list'
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
    const renderJob: RenderJob = {
      route,
      layout,
      source: prepared.path,
      content: toHtml(parsed.tree),
      page: pageContext({
        title: parsed.title,
        description: prepared.meta.description,
        url: route.url,
        lang: parsed.lang,
        date: prepared.meta.date,
        updated: prepared.meta.updated,
        tags: prepared.meta.tags,
        layout,
        sourcePath: prepared.path,
        headings: parsed.headings,
        data: prepared.meta,
        collection,
      }),
    };
    jobs.push(renderJob);
    if (isIndexOf !== undefined) indexJobs.set(isIndexOf.name, renderJob);
  }

  // Collection list pages: the index page is page 1, later pages are generated.
  const hasList = renderer.hasLayout('list');
  for (const c of collections) {
    const count = Math.max(1, Math.ceil(c.pages.length / c.perPage));
    const routes = Array.from({ length: count }, (_, i) => listRoute(c.dir, i + 1, urlOptions));
    const title = titleOf(c);
    for (let n = 1; n <= count; n++) {
      const route = routes[n - 1] as Route;
      const pagination: Pagination = {
        collection: c.name,
        page: n,
        pages: count,
        total: c.pages.length,
        items: c.pages
          .slice((n - 1) * c.perPage, n * c.perPage)
          .flatMap((p) => summaries.get(p.source) ?? []),
        first: (routes[0] as Route).url,
        last: (routes[count - 1] as Route).url,
        prev: routes[n - 2]?.url,
        next: routes[n]?.url,
      };
      const index = n === 1 ? indexJobs.get(c.name) : undefined;
      if (index !== undefined) {
        index.pagination = pagination;
        continue;
      }
      // Without a list layout there are no generated list pages.
      if (!hasList) break;
      if (n === 1 && outputs.has(route.output)) continue;
      if (!claim(route.output, `collection ${c.name}`)) continue;
      jobs.push({
        route,
        layout: 'list',
        source: undefined,
        content: '',
        pagination,
        page: pageContext({
          title: n === 1 ? title : `${title} (page ${n} of ${count})`,
          url: route.url,
          layout: 'list',
        }),
      });
    }
  }

  if (hasTagPages) {
    for (const tag of tags) {
      const route = tagRoute(tag.slug, urlOptions);
      if (!claim(route.output, `tag ${tag.name}`)) continue;
      const items = (tagged.get(tag.slug)?.pages ?? [])
        .flatMap((p) => summaries.get(p.source) ?? [])
        .sort(
          (a, b) =>
            (b.date?.getTime() ?? -Infinity) - (a.date?.getTime() ?? -Infinity) ||
            a.title.localeCompare(b.title),
        );
      jobs.push({
        route,
        layout: 'tag',
        source: undefined,
        content: '',
        tag: { ...tag, items },
        page: pageContext({ title: `Tagged “${tag.name}”`, url: route.url, layout: 'tag' }),
      });
    }
  }
  // The tag index: generated, or a content page at its URL (tags/index.md).
  let tagsUrl: string | undefined;
  const tagsIndex = tagRoute(undefined, urlOptions);
  if (outputs.has(tagsIndex.output)) {
    tagsUrl = tagsIndex.url;
  } else if (tags.length > 0 && renderer.hasLayout('tags') && claim(tagsIndex.output, 'tags')) {
    tagsUrl = tagsIndex.url;
    jobs.push({
      route: tagsIndex,
      layout: 'tags',
      source: undefined,
      content: '',
      page: pageContext({ title: 'Tags', url: tagsIndex.url, layout: 'tags' }),
    });
  }

  const searchRoute = routeFor('search.md', undefined, urlOptions);
  let search: RenderContext['search'];
  if (config.search.enabled && renderer.hasLayout('search')) {
    if (outputs.has(searchRoute.output) || claim(searchRoute.output, 'search')) {
      search = { url: searchRoute.url };
      if (outputs.get(searchRoute.output) === 'search') {
        jobs.push({
          route: searchRoute,
          layout: 'search',
          source: undefined,
          content: '',
          page: pageContext({
            title: 'Search',
            url: searchRoute.url,
            layout: 'search',
            data: { sitemap: false },
          }),
        });
      }
    }
  }

  if (!hasNotFoundPage && renderer.hasLayout('404')) {
    jobs.push({
      route: { url: '/404.html', output: '404.html' },
      layout: '404',
      source: undefined,
      content: '',
      page: pageContext({ title: 'Page not found', url: '/404.html', layout: '404' }),
    });
  }

  // 6. Render and write.
  const nav = navEntries(
    pages.flatMap(({ prepared, route, parsed }) =>
      parsed === undefined ? [] : [{ url: route.url, title: parsed.title, nav: prepared.meta.nav }],
    ),
  );
  const titles = new Map<string, string>([
    ...sitePages.map((p): [string, string] => [p.url, p.title]),
    ...jobs.map((j): [string, string] => [j.route.url, j.page.title]),
  ]);
  const data = loadData(rootDir, diagnostics);
  const now = new Date();
  const base: Omit<RenderContext, 'page' | 'content' | 'nav' | 'breadcrumbs'> = {
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
    collections: Object.fromEntries(
      collections.map((c) => [c.name, c.pages.flatMap((p) => summaries.get(p.source) ?? [])]),
    ),
    tags,
    tagsUrl,
    feeds,
    search,
  };

  rmSync(outDir, { recursive: true, force: true });
  const manifest: Record<string, ManifestEntry> = {};
  const record = (output: string, contents: Buffer | string, immutable = false) => {
    manifest[output] = {
      sha256: createHash('sha256').update(contents).digest('hex'),
      size: Buffer.byteLength(contents),
      cache: immutable ? 'immutable' : 'revalidate',
    };
  };
  const write = (output: string, contents: string | Buffer, immutable = false) => {
    const path = join(outDir, output);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
    record(output, contents, immutable);
  };

  const finish = { assetUrl, minify };
  const built: BuiltPage[] = [];
  const indexed: SearchPage[] = [];
  const bodies = new Map<string, string>();

  for (const job of jobs) {
    let html: string;
    try {
      html = renderer.render(job.layout, {
        ...base,
        page: job.page,
        content: job.content,
        nav: navFor(nav, job.route.url),
        breadcrumbs: breadcrumbsFor(job.route.url, titles),
        ...(job.pagination && { pagination: job.pagination }),
        ...(job.tag && { tag: job.tag }),
      });
    } catch (error) {
      diagnostics.push({
        ruleId: 'render-failed',
        severity: 'error',
        message: error instanceof Error ? error.message : String(error),
        ...(job.source !== undefined && { file: job.source }),
      });
      continue;
    }
    const finished = finishHtml(html, finish);
    write(job.route.output, finished);
    if (job.source !== undefined) bodies.set(job.source, job.content);
    indexed.push({ url: job.route.url, html: finished });
    built.push({
      source: job.source,
      url: job.route.url,
      output: job.route.output,
      layout: job.layout,
    });
  }

  for (const { prepared, route, parsed } of documents) {
    if (parsed === undefined) continue;
    injectHead(parsed.tree, styles, scripts);
    finishTree(parsed.tree, finish);
    const html = toHtml(parsed.tree);
    write(route.output, html);
    indexed.push({ url: route.url, html });
    built.push({ source: prepared.path, url: route.url, output: route.output, layout: 'document' });
  }

  // Feeds, sitemap and robots.txt.
  for (const feed of feedJobs) {
    const c = feed.collection;
    const listUrl = listRoute(c.dir, 1, urlOptions).url;
    const items = c.pages.slice(0, FEED_ITEMS).map((p) => {
      const body = bodies.get(p.source);
      return {
        page: summaries.get(p.source) as PageSummary,
        html:
          body === undefined ? undefined : absolutizeHtml(finishFragment(body, finish), baseUrl),
      };
    });
    const feedOptions = {
      title: `${config.site.title}: ${titleOf(c)}`,
      description: config.site.description,
      language: config.site.language,
      author: config.site.author,
      link: new URL(listUrl, baseUrl).href,
      self: new URL(feed.url, baseUrl).href,
      items,
      fallbackDate: now,
      generator: base.build.generator,
    };
    write(feed.output, feed.kind === 'rss' ? rssFeed(feedOptions) : atomFeed(feedOptions));
  }

  const metaBySource = new Map(pages.map((p) => [p.prepared.path, p.prepared.meta]));
  // Pages opt out with `sitemap: false`; the generated search page does too.
  const unlisted = new Set(
    jobs.filter((j) => j.page.data.sitemap === false).map((j) => j.route.url),
  );
  const sitemapEntries = built
    .filter((p) => p.output !== '404.html' && !unlisted.has(p.url))
    .filter((p) => p.source === undefined || metaBySource.get(p.source)?.sitemap !== false)
    .map((p) => {
      const meta = p.source === undefined ? undefined : metaBySource.get(p.source);
      return { url: new URL(p.url, baseUrl).href, lastmod: meta?.updated ?? meta?.date };
    })
    .sort((a, b) => a.url.localeCompare(b.url));
  if (!outputs.has('sitemap.xml') && claim('sitemap.xml', 'sitemap')) {
    write('sitemap.xml', sitemapXml(sitemapEntries));
  }
  if (!outputs.has('robots.txt') && claim('robots.txt', 'robots')) {
    write('robots.txt', robotsTxt(new URL('/sitemap.xml', baseUrl).href));
  }

  for (const copy of copies) write(copy.output, readFileSync(copy.source));
  for (const out of code.outputs) write(out.output, out.contents, out.immutable);
  for (const [output, file] of imageOutputs) write(output, readFileSync(file), true);

  // Search index, over the finished pages.
  if (config.search.enabled) {
    try {
      for (const file of await writeSearchIndex(indexed, outDir)) {
        record(file, readFileSync(join(outDir, file)));
      }
    } catch (error) {
      diagnostics.push({
        ruleId: 'search-failed',
        severity: 'error',
        message: `Search index could not be built: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  const sorted = sortDiagnostics(diagnostics);
  const summary = countBySeverity(sorted);
  write(
    MANIFEST_PATH,
    `${JSON.stringify({ version: 1, generator: base.build.generator, builtAt: base.build.time, baseUrl, files: manifest }, null, 2)}\n`,
  );

  return {
    ok: summary.error === 0,
    outDir,
    pages: built.sort((a, b) => a.url.localeCompare(b.url)),
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
