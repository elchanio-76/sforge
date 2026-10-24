import type { PageSummary } from '@staticforge/render';

const xml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

/** Make root-relative URLs in page HTML absolute, as feed readers need. */
export function absolutizeHtml(html: string, baseUrl: string): string {
  const absolute = (url: string) =>
    url.startsWith('/') && !url.startsWith('//') ? new URL(url, baseUrl).href : url;
  return html
    .replace(
      /(\s(?:href|src|poster)=")([^"]*)"/g,
      (_m, attr: string, url: string) => `${attr}${absolute(url)}"`,
    )
    .replace(/(\ssrcset=")([^"]*)"/g, (_m, attr: string, set: string) => {
      const candidates = set.split(',').map((c) => {
        const [url = '', ...descriptor] = c.trim().split(/\s+/);
        return [absolute(url), ...descriptor].join(' ');
      });
      return `${attr}${candidates.join(', ')}"`;
    });
}

export interface FeedOptions {
  title: string;
  description: string | undefined;
  language: string;
  author: string | undefined;
  /** Absolute URL of the collection's list page. */
  link: string;
  /** Absolute URL of the feed itself. */
  self: string;
  items: { page: PageSummary; html: string | undefined }[];
  /** Used when no item has a date. */
  fallbackDate: Date;
  generator: string;
}

/** Entries in a feed: the most recent ones. */
export const FEED_ITEMS = 20;

const newest = (options: FeedOptions): Date =>
  options.items.reduce<Date | undefined>((latest, { page }) => {
    const date = page.updated ?? page.date;
    return date !== undefined && (latest === undefined || date > latest) ? date : latest;
  }, undefined) ?? options.fallbackDate;

const cdata = (text: string): string => `<![CDATA[${text.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;

/** RSS 2.0, with the full content in content:encoded. */
export function rssFeed(options: FeedOptions): string {
  const items = options.items.map(({ page, html }) => {
    const lines = [
      '    <item>',
      `      <title>${xml(page.title)}</title>`,
      `      <link>${xml(page.absoluteUrl)}</link>`,
      `      <guid isPermaLink="true">${xml(page.absoluteUrl)}</guid>`,
      page.date !== undefined ? `      <pubDate>${page.date.toUTCString()}</pubDate>` : undefined,
      page.description !== undefined
        ? `      <description>${xml(page.description)}</description>`
        : undefined,
      ...page.tags.map((tag) => `      <category>${xml(tag.name)}</category>`),
      html !== undefined ? `      <content:encoded>${cdata(html)}</content:encoded>` : undefined,
      '    </item>',
    ];
    return lines.filter((l) => l !== undefined).join('\n');
  });
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">',
    '  <channel>',
    `    <title>${xml(options.title)}</title>`,
    `    <link>${xml(options.link)}</link>`,
    `    <description>${xml(options.description ?? options.title)}</description>`,
    `    <language>${xml(options.language)}</language>`,
    `    <lastBuildDate>${newest(options).toUTCString()}</lastBuildDate>`,
    `    <generator>${xml(options.generator)}</generator>`,
    `    <atom:link href="${xml(options.self)}" rel="self" type="application/rss+xml"/>`,
    ...items,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
}

/** Atom 1.0. Entries without a date use the feed's date, as Atom requires one. */
export function atomFeed(options: FeedOptions): string {
  const updated = newest(options);
  const entries = options.items.map(({ page, html }) => {
    const lines = [
      '  <entry>',
      `    <title>${xml(page.title)}</title>`,
      `    <link href="${xml(page.absoluteUrl)}"/>`,
      `    <id>${xml(page.absoluteUrl)}</id>`,
      `    <updated>${(page.updated ?? page.date ?? updated).toISOString()}</updated>`,
      page.date !== undefined ? `    <published>${page.date.toISOString()}</published>` : undefined,
      page.description !== undefined
        ? `    <summary>${xml(page.description)}</summary>`
        : undefined,
      ...page.tags.map((tag) => `    <category term="${xml(tag.name)}"/>`),
      html !== undefined ? `    <content type="html">${xml(html)}</content>` : undefined,
      '  </entry>',
    ];
    return lines.filter((l) => l !== undefined).join('\n');
  });
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${xml(options.language)}">`,
    `  <title>${xml(options.title)}</title>`,
    options.description !== undefined
      ? `  <subtitle>${xml(options.description)}</subtitle>`
      : undefined,
    `  <link href="${xml(options.link)}"/>`,
    `  <link href="${xml(options.self)}" rel="self" type="application/atom+xml"/>`,
    `  <id>${xml(options.link)}</id>`,
    `  <updated>${updated.toISOString()}</updated>`,
    options.author !== undefined
      ? `  <author><name>${xml(options.author)}</name></author>`
      : undefined,
    `  <generator>${xml(options.generator)}</generator>`,
    ...entries,
    '</feed>',
    '',
  ]
    .filter((l) => l !== undefined)
    .join('\n');
}

/** sitemap.xml (sitemaps.org protocol). */
export function sitemapXml(entries: { url: string; lastmod: Date | undefined }[]): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries.map(({ url, lastmod }) =>
      lastmod !== undefined
        ? `  <url><loc>${xml(url)}</loc><lastmod>${lastmod.toISOString().slice(0, 10)}</lastmod></url>`
        : `  <url><loc>${xml(url)}</loc></url>`,
    ),
    '</urlset>',
    '',
  ].join('\n');
}

export function robotsTxt(sitemapUrl: string): string {
  return `User-agent: *\nAllow: /\n\nSitemap: ${sitemapUrl}\n`;
}
