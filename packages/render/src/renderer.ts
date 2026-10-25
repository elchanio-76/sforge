import { existsSync } from 'node:fs';
import { join } from 'node:path';
import nunjucks from 'nunjucks';
import { ErrorCode, SforgeError } from '@staticforge/core';
import { type Theme, themeAssetUrl } from './theme.js';

export interface SiteContext {
  title: string;
  description: string | undefined;
  author: string | undefined;
  language: string;
  baseUrl: string;
}

export interface NavItem {
  title: string;
  url: string;
  /** The item is the current page (`aria-current="page"`). */
  current: boolean;
  /** The current page is inside this item's section. */
  active: boolean;
}

export interface PageContext {
  title: string;
  description: string | undefined;
  url: string;
  absoluteUrl: string;
  lang: string;
  date: Date | undefined;
  updated: Date | undefined;
  tags: string[];
  /** The page's tags with their slugs and tag page URLs. */
  tagLinks: TagRef[];
  layout: string;
  /** Project-relative source file, or undefined for generated pages. */
  sourcePath: string | undefined;
  headings: { depth: number; id: string | undefined; text: string }[];
  /** Raw front-matter, including keys staticforge doesn't know. */
  data: Record<string, unknown>;
  /** Name of the collection the page belongs to, if any. */
  collection?: string | undefined;
}

/** A page as listed in collections, tag pages and feeds. */
export interface PageSummary {
  title: string;
  url: string;
  absoluteUrl: string;
  description: string | undefined;
  date: Date | undefined;
  updated: Date | undefined;
  tags: TagRef[];
}

export interface TagRef {
  name: string;
  slug: string;
  /** URL of the tag's page, or undefined when the theme has no tag layout. */
  url: string | undefined;
}

export interface TagSummary extends TagRef {
  count: number;
}

/** One page of a collection's list (`layouts/list.njk`). */
export interface Pagination {
  collection: string;
  /** 1-based. */
  page: number;
  pages: number;
  total: number;
  items: PageSummary[];
  first: string;
  last: string;
  prev: string | undefined;
  next: string | undefined;
}

export interface Breadcrumb {
  title: string;
  url: string;
  /** The last crumb: the current page. */
  current: boolean;
}

export interface FeedLink {
  type: 'application/rss+xml' | 'application/atom+xml';
  title: string;
  url: string;
}

/** Everything a layout can use. Documented in docs/content/themes.md. */
export interface RenderContext {
  site: SiteContext;
  page: PageContext;
  /** Page body HTML; output with `{{ content | safe }}`. */
  content: string;
  nav: NavItem[];
  theme: { styles: string[]; scripts: string[] };
  /** Contents of the project's data/ directory, keyed by file name. */
  data: Record<string, unknown>;
  build: { generator: string; time: string; year: number };
  /** Each configured collection's pages, sorted. */
  collections: Record<string, PageSummary[]>;
  /** Every tag, by name. */
  tags: TagSummary[];
  /** URL of the page listing every tag, when there is one. */
  tagsUrl: string | undefined;
  /** Home, the page's ancestors that are pages, and the page. */
  breadcrumbs: Breadcrumb[];
  /** Collection feeds, for `<link rel="alternate">`. */
  feeds: FeedLink[];
  /** The search page, when search is enabled. */
  search: { url: string } | undefined;
  /** On collection list pages. */
  pagination?: Pagination;
  /** On tag pages. */
  tag?: TagSummary & { items: PageSummary[] };
}

export interface Renderer {
  hasLayout(name: string): boolean;
  /** Render `layouts/<layout>.njk`. Throws SF_THEME_INVALID on template errors. */
  render(layout: string, context: RenderContext): string;
}

const toDate = (value: unknown): Date | undefined => {
  const date =
    value instanceof Date ? value : typeof value === 'string' ? new Date(value) : undefined;
  return date !== undefined && !Number.isNaN(date.getTime()) ? date : undefined;
};

/**
 * Create a renderer for a theme. Templates in the project's `templates/`
 * directory (same structure as the theme) override the theme's.
 */
export function createRenderer(
  theme: Theme,
  options: {
    rootDir: string;
    baseUrl: string;
    /** Final URL of a site asset, e.g. its fingerprinted name. Defaults to the URL itself. */
    assetUrl?: (url: string) => string;
  },
): Renderer {
  const overridesDir = join(options.rootDir, 'templates');
  const searchPaths = [overridesDir, theme.dir].filter((dir) => existsSync(dir));
  // A renderer lives for one build, so templates are compiled once per build
  // and edits still show up in the next one (e.g. under `sforge dev`).
  const env = new nunjucks.Environment(
    new nunjucks.FileSystemLoader(searchPaths, { noCache: false }),
    {
      autoescape: true,
      trimBlocks: true,
      lstripBlocks: true,
    },
  );

  env.addFilter(
    'absoluteUrl',
    (path: unknown) => new URL(String(path ?? '/'), options.baseUrl).href,
  );
  env.addFilter('isoDate', (value: unknown) => toDate(value)?.toISOString().slice(0, 10) ?? '');
  env.addFilter('readableDate', (value: unknown, lang?: string) => {
    const date = toDate(value);
    if (date === undefined) return '';
    return new Intl.DateTimeFormat(lang ?? 'en', { dateStyle: 'long', timeZone: 'UTC' }).format(
      date,
    );
  });

  const assetUrl = options.assetUrl ?? ((url: string) => url);
  env.addFilter('asset', (url: unknown) => assetUrl(String(url)));
  env.addFilter('themeAsset', (path: unknown) => assetUrl(themeAssetUrl(String(path))));

  const layouts = new Set(theme.manifest.layouts);

  return {
    hasLayout: (name) =>
      layouts.has(name) || existsSync(join(overridesDir, 'layouts', `${name}.njk`)),
    render(layout, context) {
      try {
        return env.render(`layouts/${layout}.njk`, context);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message.replace(/^\(unknown path\)\s*/, '')
            : String(error);
        throw new SforgeError(
          ErrorCode.ThemeInvalid,
          `Layout "${layout}" failed to render: ${message}`,
          {
            cause: error,
          },
        );
      }
    },
  };
}
