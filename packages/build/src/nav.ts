import type { NavItem } from '@staticforge/render';

export interface NavCandidate {
  url: string;
  title: string;
  nav: { order?: number | undefined; label?: string | undefined; hide: boolean } | undefined;
}

/** Top-level pages, plus deeper pages that opt in with `nav.order`. Excludes home and 404. */
export function navEntries(pages: NavCandidate[]): Omit<NavItem, 'current' | 'active'>[] {
  const topLevel = (url: string) => /^\/[^/]+(\/|\.html)?$/.test(url);
  return pages
    .filter((p) => p.url !== '/' && p.url !== '/404.html' && p.nav?.hide !== true)
    .filter((p) => topLevel(p.url) || p.nav?.order !== undefined)
    .map((p) => ({ title: p.nav?.label ?? p.title, url: p.url, order: p.nav?.order ?? Infinity }))
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
    .map(({ title, url }) => ({ title, url }));
}

/** Mark the current page, and the section containing it. */
export function navFor(entries: Omit<NavItem, 'current' | 'active'>[], pageUrl: string): NavItem[] {
  return entries.map((entry) => {
    const current = entry.url === pageUrl;
    const section = entry.url.endsWith('/') ? entry.url : `${entry.url}/`;
    return { ...entry, current, active: current || pageUrl.startsWith(section) };
  });
}
