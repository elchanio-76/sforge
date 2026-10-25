import { posix } from 'node:path';
import type { Root } from 'hast';
import { toHtml } from 'hast-util-to-html';
import { visit } from 'unist-util-visit';
import {
  type ParsedContent,
  type PreparedSource,
  createReport,
  parseContent,
} from '@staticforge/content';
import type { Diagnostic } from '@staticforge/core';
import {
  type NavItem,
  type Pagination,
  type PageContext,
  type PageSummary,
  type RenderContext,
  type Renderer,
  type TagSummary,
  createRenderer,
  loadTheme,
} from '@staticforge/render';
import { finishHtml } from './html.js';
import { navFor } from './nav.js';
import { createRefResolver } from './routes.js';
import { breadcrumbsFor } from './site.js';

/*
 * The per-page work of a build, as functions of plain data, so it can run in
 * worker threads (see `WorkerPool` in @staticforge/core) or in this thread.
 */

/** Below this many pages, work stays in the main thread: starting workers costs more. */
export const MIN_PAGES_FOR_WORKERS = 100;

export const PARSE_TASK = { module: import.meta.url, fn: 'parsePages' };
export const RENDER_TASK = { module: import.meta.url, fn: 'renderPages' };

/** Whether a root-relative URL path names an output file or directory index. */
export function outputExists(outputs: { has(path: string): boolean }, urlPath: string): boolean {
  let path: string;
  try {
    path = decodeURI(urlPath.split(/[?#]/)[0] ?? '').replace(/^\//, '');
  } catch {
    return false;
  }
  return (
    outputs.has(path) || outputs.has(posix.join(path, 'index.html')) || outputs.has(`${path}.html`)
  );
}

/** The final URL of an asset: its fingerprinted name, keeping a query or fragment. */
export function assetUrlFor(urls: ReadonlyMap<string, string>): (url: string) => string {
  return (url) => {
    const [, path = url, rest = ''] = /^([^?#]*)(.*)$/s.exec(url) ?? [];
    return (urls.get(path) ?? path) + rest;
  };
}

export interface ParseContext {
  language: string;
  /** Page URL by project-relative source path. */
  pageUrls: Map<string, string>;
  /** Every output path of the build. */
  outputs: Set<string>;
  /** Whether content images are optimized (their pages then need their trees). */
  optimizeImages: boolean;
}

/**
 * A parsed page. Pages the build still changes (documents, and fragments with
 * images to optimize) keep their tree; the others carry their HTML, which is
 * much cheaper to send between threads and safe to cache.
 */
export type ParsedPage = Omit<ParsedContent, 'tree'> &
  ({ tree: Root; html?: undefined } | { tree?: undefined; html: string });

function hasImage(tree: Root): boolean {
  let found = false;
  visit(tree, 'element', (node) => {
    if (node.tagName === 'img') found = true;
    return found ? false : undefined;
  });
  return found;
}

export interface ParseResult {
  parsed: ParsedPage;
  /** Problems found while resolving references (reported before `parsed.diagnostics`). */
  references: Diagnostic[];
}

/** Parse pages to HAST; references resolve against all pages and outputs of the build. */
export async function parsePages(input: {
  items: PreparedSource[];
  context: ParseContext;
}): Promise<ParseResult[]> {
  const { language, pageUrls, outputs, optimizeImages } = input.context;
  const fileExists = (urlPath: string) => outputExists(outputs, urlPath);
  const results: ParseResult[] = [];
  for (const prepared of input.items) {
    const references: Diagnostic[] = [];
    const report = createReport(prepared.path, references);
    const parsed = await parseContent(prepared, {
      language,
      resolveRef: createRefResolver({ sourcePath: prepared.path, pageUrls, report }),
      fileExists,
    });
    const { tree, ...rest } = parsed;
    const keepTree = parsed.kind === 'document' || (optimizeImages && hasImage(tree));
    results.push({
      parsed: keepTree ? { ...rest, tree } : { ...rest, html: toHtml(tree) },
      references,
    });
  }
  return results;
}

export interface RenderContextShared {
  /** Distinguishes builds, so workers never reuse a renderer (and its templates) across them. */
  buildId: string;
  theme: string;
  rootDir: string;
  baseUrl: string;
  /** Fingerprinted URL by asset URL. */
  assetUrls: Map<string, string>;
  minify: boolean;
  noindex: boolean;
  base: Omit<RenderContext, 'page' | 'content' | 'nav' | 'breadcrumbs'>;
  nav: Omit<NavItem, 'current' | 'active'>[];
  /** Page title by URL, for breadcrumbs. */
  titles: Map<string, string>;
}

export interface RenderItem {
  layout: string;
  url: string;
  page: PageContext;
  content: string;
  pagination?: Pagination;
  tag?: TagSummary & { items: PageSummary[] };
}

export type RenderResult = { html: string } | { error: string };

let cached: { buildId: string; renderer: Renderer } | undefined;

/** Render pages with their layouts and finish them (asset URLs, minification). */
export function renderPages(input: {
  items: RenderItem[];
  context: RenderContextShared;
}): RenderResult[] {
  const { context } = input;
  const assetUrl = assetUrlFor(context.assetUrls);
  if (cached?.buildId !== context.buildId) {
    const theme = loadTheme(context.theme, context.rootDir);
    cached = {
      buildId: context.buildId,
      renderer: createRenderer(theme, {
        rootDir: context.rootDir,
        baseUrl: context.baseUrl,
        assetUrl,
      }),
    };
  }
  const { renderer } = cached;
  return input.items.map((item) => {
    let html: string;
    try {
      html = renderer.render(item.layout, {
        ...context.base,
        page: item.page,
        content: item.content,
        nav: navFor(context.nav, item.url),
        breadcrumbs: breadcrumbsFor(item.url, context.titles),
        ...(item.pagination && { pagination: item.pagination }),
        ...(item.tag && { tag: item.tag }),
      });
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
    return {
      html: finishHtml(html, { assetUrl, minify: context.minify, noindex: context.noindex }),
    };
  });
}
