import { posix } from 'node:path';
import type { PageMeta } from '@staticforge/content';
import type { SforgeConfig } from '@staticforge/core';
import type { Breadcrumb, PageSummary, TagRef } from '@staticforge/render';
import { ProjectDirs } from './project.js';
import { type Route, type UrlOptions, routeFor } from './routes.js';

/** A built page with what site features need to know about it. */
export interface SitePage {
  source: string;
  url: string;
  title: string;
  meta: PageMeta;
}

export interface Collection {
  name: string;
  /** Content-relative directory, e.g. "blog". */
  dir: string;
  /** Source of the collection's index page (`blog/_index.md`), if it has one. */
  index: string | undefined;
  /** Members, sorted. */
  pages: SitePage[];
  perPage: number;
  feed: { rss: boolean; atom: boolean };
}

const INDEX = /(^|\/)_?index\.[^/]+$/;

/** "Static Sites" → "static-sites"; "C++" → "c"; non-Latin letters are kept. */
export function slugify(text: string): string {
  return (
    text
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '') || 'tag'
  );
}

const time = (date: Date | undefined): number => date?.getTime() ?? -Infinity;

/**
 * Group pages into the configured collections. A collection's members are the
 * pages under its directory, except section index pages.
 */
export function collectionsOf(
  config: SforgeConfig['collections'],
  pages: SitePage[],
): { collections: Collection[]; problems: string[] } {
  const collections: Collection[] = [];
  const problems: string[] = [];
  for (const [name, options] of Object.entries(config)) {
    const dir = posix.normalize(options.dir).replace(/\/+$/, '');
    const prefix = `${ProjectDirs.content}/`;
    if (!dir.startsWith(prefix) && dir !== ProjectDirs.content) {
      problems.push(
        `Collection "${name}": dir "${options.dir}" must be inside ${ProjectDirs.content}/`,
      );
      continue;
    }
    const contentDir = dir === ProjectDirs.content ? '' : dir.slice(prefix.length);
    const within = (source: string) => source.startsWith(`${dir}/`);
    const members = pages.filter((p) => within(p.source) && !INDEX.test(p.source));
    const index = pages.find(
      (p) => posix.dirname(p.source) === dir && INDEX.test(p.source),
    )?.source;

    const sorted = [...members].sort((a, b) => {
      switch (options.sortBy) {
        case 'title':
          return a.title.localeCompare(b.title);
        case 'order':
          return (
            (a.meta.order ?? Infinity) - (b.meta.order ?? Infinity) ||
            a.title.localeCompare(b.title)
          );
        default:
          // Newest first; undated pages last, by title.
          return time(b.meta.date) - time(a.meta.date) || a.title.localeCompare(b.title);
      }
    });
    collections.push({
      name,
      dir: contentDir,
      index,
      pages: sorted,
      perPage: options.perPage,
      feed: options.feed,
    });
  }
  return { collections, problems };
}

/** Route of a collection's list page `n` (1-based): /blog/, /blog/page/2/, … */
export function listRoute(dir: string, n: number, urls: UrlOptions): Route {
  const base = dir === '' ? '' : `${dir}/`;
  return routeFor(n === 1 ? `${base}index.md` : `${base}page/${n}.md`, undefined, urls);
}

/** Route of a tag's page, /tags/<slug>/, or the tag index, /tags/. */
export function tagRoute(slug: string | undefined, urls: UrlOptions): Route {
  return routeFor(slug === undefined ? 'tags/index.md' : `tags/${slug}.md`, undefined, urls);
}

export function summarize(
  page: SitePage,
  baseUrl: string,
  tagUrl: (slug: string) => string | undefined,
): PageSummary {
  return {
    title: page.title,
    url: page.url,
    absoluteUrl: new URL(page.url, baseUrl).href,
    description: page.meta.description,
    date: page.meta.date,
    updated: page.meta.updated,
    tags: tagsOf(page.meta.tags, tagUrl),
  };
}

export function tagsOf(names: string[], tagUrl: (slug: string) => string | undefined): TagRef[] {
  return names.map((name) => {
    const slug = slugify(name);
    return { name, slug, url: tagUrl(slug) };
  });
}

/**
 * Home, then each ancestor URL that is a page, then the page itself:
 * /guides/setup/ → Home › Guides › Setup.
 */
export function breadcrumbsFor(url: string, titles: ReadonlyMap<string, string>): Breadcrumb[] {
  const crumbs: Breadcrumb[] = [];
  const home = titles.get('/');
  if (home !== undefined && url !== '/') crumbs.push({ title: home, url: '/', current: false });
  const segments = url
    .replace(/^\/|\/$/g, '')
    .split('/')
    .filter((s) => s !== '');
  for (let i = 1; i < segments.length; i++) {
    const path = `/${segments.slice(0, i).join('/')}`;
    const ancestor = titles.has(`${path}/`) ? `${path}/` : titles.has(path) ? path : undefined;
    if (ancestor !== undefined) {
      crumbs.push({ title: titles.get(ancestor) ?? '', url: ancestor, current: false });
    }
  }
  const title = titles.get(url);
  if (title !== undefined) crumbs.push({ title, url, current: true });
  return crumbs;
}
