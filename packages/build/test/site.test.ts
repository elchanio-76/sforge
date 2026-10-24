import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { breadcrumbsFor, buildSite, slugify } from '../src/index.js';
import { PNG, config, read, tempProject } from './helpers.js';

const post = (title: string, date: string, extra = '') =>
  `---\ntitle: ${title}\ndate: ${date}\n${extra}---\nBody of ${title}. See [home](/).\n`;

const blog = {
  'content/index.md': '# Home\n',
  'content/blog/_index.md': '---\ntitle: News\n---\nThe latest.\n',
  'content/blog/a.md': post('Alpha', '2026-01-01', 'tags: [Release Notes]\n'),
  'content/blog/b.md': post(
    'Bravo',
    '2026-03-01',
    'tags: [release notes, AWS]\ndescription: Second <post>\n',
  ),
  'content/blog/c.md': post('Charlie', '2026-02-01', 'sitemap: false\n'),
  'content/blog/2026/_index.md': '# 2026\n',
};

const blogConfig = (overrides: Record<string, unknown> = {}) =>
  config({ collections: { blog: { dir: 'content/blog', perPage: 2, ...overrides } } });

const hrefs = (html: string, selector: string) =>
  [...html.slice(html.indexOf(selector)).matchAll(/<h2><a href="([^"]+)">/g)].map((m) => m[1]);

describe('collections', () => {
  it('lists members newest first, paginated, on the index page and generated pages', async () => {
    const result = await buildSite({ rootDir: tempProject(blog), config: blogConfig() });
    expect(result.diagnostics).toEqual([]);
    const layouts = Object.fromEntries(result.pages.map((p) => [p.url, p.layout]));
    expect(layouts).toMatchObject({
      '/blog/': 'list',
      '/blog/page/2/': 'list',
      '/blog/a/': 'post',
      '/blog/2026/': 'page',
    });

    const first = read(result.outDir, 'blog/index.html');
    expect(first).toContain('<p>The latest.</p>');
    expect(hrefs(first, 'page-list')).toEqual(['/blog/b/', '/blog/c/']);
    expect(first).toContain('<link rel="next" href="/blog/page/2/">');
    expect(first).toContain('Page 1 of 2');

    const second = read(result.outDir, 'blog/page/2/index.html');
    expect(second).toContain('<title>News (page 2 of 2) | Test</title>');
    expect(hrefs(second, 'page-list')).toEqual(['/blog/a/']);
    expect(second).toContain('<a href="/blog/" rel="prev">Previous page</a>');
  });

  it('sorts by title or order, and generates the list page when there is no index', async () => {
    const files = { ...blog, 'content/blog/_index.md': undefined };
    delete files['content/blog/_index.md'];
    const byTitle = await buildSite({
      rootDir: tempProject(files as Record<string, string>),
      config: blogConfig({ sortBy: 'title', perPage: 10 }),
    });
    const list = read(byTitle.outDir, 'blog/index.html');
    expect(list).toContain('<h1>Blog</h1>');
    expect(hrefs(list, 'page-list')).toEqual(['/blog/a/', '/blog/b/', '/blog/c/']);

    const byOrder = await buildSite({
      rootDir: tempProject({
        ...blog,
        'content/blog/a.md': '---\ntitle: Alpha\norder: 2\n---\n',
        'content/blog/b.md': '---\ntitle: Bravo\norder: 1\n---\n',
      }),
      config: blogConfig({ sortBy: 'order', perPage: 10 }),
    });
    expect(hrefs(read(byOrder.outDir, 'blog/index.html'), 'page-list')).toEqual([
      '/blog/b/',
      '/blog/a/',
      '/blog/c/',
    ]);
  });

  it('writes RSS and Atom feeds with absolute URLs and full content', async () => {
    const result = await buildSite({ rootDir: tempProject(blog), config: blogConfig() });
    const rss = read(result.outDir, 'blog/feed.xml');
    expect(rss).toContain('<title>Test: News</title>');
    expect(rss).toContain('<atom:link href="https://example.com/blog/feed.xml" rel="self"');
    expect(rss).toContain('<description>Second &lt;post&gt;</description>');
    expect(rss).toContain('<pubDate>Sun, 01 Mar 2026 00:00:00 GMT</pubDate>');
    expect(rss).toContain('<category>AWS</category>');
    expect(rss).toContain(
      '<content:encoded><![CDATA[<p>Body of Bravo. See <a href="https://example.com/">home</a>.</p>]]></content:encoded>',
    );
    expect(rss.indexOf('Bravo')).toBeLessThan(rss.indexOf('Charlie'));

    const atom = read(result.outDir, 'blog/atom.xml');
    expect(atom).toContain('<updated>2026-03-01T00:00:00.000Z</updated>');
    expect(atom).toContain('<content type="html">&lt;p&gt;Body of Bravo.');
    expect(read(result.outDir, 'index.html')).toContain(
      '<link rel="alternate" type="application/atom+xml" title="Test: News (Atom)" href="/blog/atom.xml">',
    );

    const noFeeds = await buildSite({
      rootDir: tempProject(blog),
      config: blogConfig({ feed: { rss: false, atom: false } }),
    });
    expect(existsSync(join(noFeeds.outDir, 'blog/feed.xml'))).toBe(false);
  });

  it('rejects collection directories outside content/', async () => {
    const result = await buildSite({
      rootDir: tempProject(blog),
      config: config({ collections: { x: { dir: 'posts' } } }),
    });
    expect(result.diagnostics).toMatchObject([{ ruleId: 'collection-invalid', severity: 'error' }]);
  });
});

describe('tags', () => {
  it('slugifies names', () => {
    expect(slugify('Release Notes')).toBe('release-notes');
    expect(slugify('Café & Crème')).toBe('cafe-creme');
    expect(slugify('Ελληνικά')).toBe('ελληνικα');
    expect(slugify('!!!')).toBe('tag');
  });

  it('builds a page per tag and an index, merging names with the same slug', async () => {
    const { outDir } = await buildSite({ rootDir: tempProject(blog), config: blogConfig() });
    const tag = read(outDir, 'tags/release-notes/index.html');
    expect(tag).toContain('<h1>Tagged “Release Notes”</h1>');
    expect(tag).toContain('2 pages with this tag.');
    expect(hrefs(tag, 'page-list')).toEqual(['/blog/b/', '/blog/a/']);
    expect(tag).toContain('<a href="/tags/">All tags</a>');

    expect(read(outDir, 'tags/index.html')).toContain('<a href="/tags/aws/">AWS');
    expect(read(outDir, 'blog/b/index.html')).toContain('<li><a href="/tags/aws/">AWS</a></li>');
  });

  it('keeps a content page at /tags/', async () => {
    const { outDir, diagnostics } = await buildSite({
      rootDir: tempProject({ ...blog, 'content/tags/index.md': '# All the tags\n' }),
      config: blogConfig(),
    });
    expect(diagnostics).toEqual([]);
    expect(read(outDir, 'tags/index.html')).toContain('All the tags');
  });
});

describe('breadcrumbsFor', () => {
  it('lists home and the ancestors that are pages', () => {
    const titles = new Map([
      ['/', 'Home'],
      ['/guides/', 'Guides'],
      ['/guides/a/b/', 'Deep'],
    ]);
    expect(breadcrumbsFor('/guides/a/b/', titles)).toEqual([
      { title: 'Home', url: '/', current: false },
      { title: 'Guides', url: '/guides/', current: false },
      { title: 'Deep', url: '/guides/a/b/', current: true },
    ]);
    expect(breadcrumbsFor('/', titles)).toEqual([{ title: 'Home', url: '/', current: true }]);
  });
});

describe('sitemap, robots.txt and search', () => {
  it('lists pages in sitemap.xml with their dates, except opted-out ones', async () => {
    const { outDir } = await buildSite({ rootDir: tempProject(blog), config: blogConfig() });
    const sitemap = read(outDir, 'sitemap.xml');
    expect(sitemap).toContain(
      '<url><loc>https://example.com/blog/b/</loc><lastmod>2026-03-01</lastmod></url>',
    );
    expect(sitemap).toContain('<loc>https://example.com/tags/aws/</loc>');
    for (const missing of ['/blog/c/', '/404.html', '/search/']) {
      expect(sitemap).not.toContain(`https://example.com${missing}<`);
    }
    expect(read(outDir, 'robots.txt')).toBe(
      'User-agent: *\nAllow: /\n\nSitemap: https://example.com/sitemap.xml\n',
    );
  });

  it('keeps a robots.txt from static/', async () => {
    const { outDir } = await buildSite({
      rootDir: tempProject({ ...blog, 'static/robots.txt': 'User-agent: *\nDisallow: /\n' }),
      config: blogConfig(),
    });
    expect(read(outDir, 'robots.txt')).toBe('User-agent: *\nDisallow: /\n');
  });

  it('indexes content pages for search, or skips search when disabled', async () => {
    const { outDir } = await buildSite({ rootDir: tempProject(blog), config: blogConfig() });
    expect(existsSync(join(outDir, 'pagefind/pagefind.js'))).toBe(true);
    expect(readdirSync(join(outDir, 'pagefind/fragment')).length).toBeGreaterThan(0);
    const search = read(outDir, 'search/index.html');
    expect(search).toMatch(
      /<script type="module" src="\/assets\/theme\/js\/search\.[0-9a-f]{8}\.js">/,
    );
    expect(read(outDir, 'index.html')).toContain('<a class="search-link" href="/search/"');

    const off = await buildSite({
      rootDir: tempProject(blog),
      config: config({ search: { enabled: false } }),
    });
    expect(existsSync(join(off.outDir, 'pagefind'))).toBe(false);
    expect(existsSync(join(off.outDir, 'search/index.html'))).toBe(false);
    expect(read(off.outDir, 'index.html')).not.toContain('search-link');
  });

  it('uses URLs without trailing slashes for generated pages when configured', async () => {
    const result = await buildSite({
      rootDir: tempProject(blog),
      config: config({
        build: { trailingSlash: 'never' },
        collections: { blog: { dir: 'content/blog', perPage: 2 } },
      }),
    });
    const urls = result.pages.map((p) => p.url);
    expect(urls).toEqual(
      expect.arrayContaining(['/blog', '/blog/page/2', '/tags/aws', '/tags', '/search']),
    );
  });
});

describe('stylesheets and scripts', () => {
  const project = {
    'content/index.md': '# Home\n\n<link rel="stylesheet" href="/assets/css/site.css">\n',
    'assets/css/site.css': '@import "./tokens.css";\n.card {\n  user-select: none;\n}\n',
    'assets/css/tokens.css': ':root {\n  --brand: #0a58ca;\n}\n',
    'assets/js/main.ts':
      "import { greet } from './greet.ts';\nconst who: string = 'you';\ngreet(who);\nimport('/pagefind/pagefind.js');\n",
    'assets/js/greet.ts':
      'export const greet = (name: string): void => console.log(`hi ${name}`);\n',
  };
  const settings = config({ styles: ['/assets/css/site.css'], scripts: ['/assets/js/main.ts'] });

  it('bundles, minifies and fingerprints them, and rewrites references', async () => {
    const result = await buildSite({ rootDir: tempProject(project), config: settings });
    expect(result.diagnostics).toEqual([]);
    const files = readdirSync(join(result.outDir, 'assets/css'));
    const hashed = files.find((f) => /^site\.[0-9a-f]{8}\.css$/.test(f)) as string;
    const css = read(result.outDir, `assets/css/${hashed}`);
    expect(css).toBe(':root{--brand:#0a58ca}.card{-webkit-user-select:none;user-select:none}');
    expect(read(result.outDir, 'assets/css/site.css')).toBe(css);

    const home = read(result.outDir, 'index.html');
    // Both the theme-level reference and the one in the content.
    expect(
      home.match(new RegExp(`href="/assets/css/${hashed.replace('.', '\\.')}"`, 'g')),
    ).toHaveLength(2);

    const script = home.match(/src="\/assets\/js\/(main\.[0-9a-f]{8}\.js)"/)?.[1] as string;
    const js = read(result.outDir, `assets/js/${script}`);
    expect(js).toContain('console.log(`hi ${');
    expect(js).toContain('import("/pagefind/pagefind.js")');
    expect(js).not.toContain(': string');
    expect(existsSync(join(result.outDir, 'assets/js/main.ts'))).toBe(false);
    expect(existsSync(join(result.outDir, 'assets/js/main.js'))).toBe(true);

    const manifest = JSON.parse(read(result.outDir, '.sforge/build-manifest.json'));
    expect(manifest.files[`assets/css/${hashed}`].cache).toBe('immutable');
    expect(manifest.files['assets/css/site.css'].cache).toBe('revalidate');
  });

  it('keeps names and formatting without fingerprinting and minifying', async () => {
    const result = await buildSite({
      rootDir: tempProject(project),
      config: settings,
      fingerprint: false,
      minify: false,
    });
    const home = read(result.outDir, 'index.html');
    expect(home).toContain('<link rel="stylesheet" href="/assets/css/site.css">\n');
    expect(home).toContain('<script type="module" src="/assets/js/main.js">');
    expect(read(result.outDir, 'assets/css/site.css')).toContain('.card {\n');
  });

  it('reports files that cannot be processed', async () => {
    const result = await buildSite({
      rootDir: tempProject({ ...project, 'assets/js/broken.js': 'const = ;' }),
      config: settings,
    });
    expect(result.diagnostics).toMatchObject([
      { ruleId: 'asset-failed', severity: 'error', file: 'assets/js/broken.js' },
    ]);
  });
});

describe('images', () => {
  it('turns content images into responsive pictures, reusing cached variants', async () => {
    const root = tempProject({
      'content/index.md': '# Home\n\n![Blue](blue.png)\n',
      'content/blue.png': PNG,
    });
    const first = await buildSite({
      rootDir: root,
      config: config({ images: { widths: [32, 480] } }),
    });
    expect(first.diagnostics).toEqual([]);
    const html = read(first.outDir, 'index.html');
    const picture = html.slice(html.indexOf('<picture>'), html.indexOf('</picture>'));
    expect(picture).toMatch(
      /<source type="image\/avif" srcset="\/_assets\/img\/blue-[0-9a-f]{10}-32\.avif 32w, \/_assets\/img\/blue-[0-9a-f]{10}-64\.avif 64w"/,
    );
    expect(picture).toContain('<source type="image/webp"');
    expect(picture).toMatch(/<img src="\/_assets\/img\/blue-[0-9a-f]{10}-64\.png" alt="Blue"/);
    expect(picture).toContain('width="64" height="48"');

    const cache = join(root, '.sforge/cache/images');
    const before = readdirSync(cache).map((f) => statSync(join(cache, f)).mtimeMs);
    await buildSite({ rootDir: root, config: config({ images: { widths: [32, 480] } }) });
    expect(readdirSync(cache).map((f) => statSync(join(cache, f)).mtimeMs)).toEqual(before);
  });

  it('keeps author sizes, skips documents and SVGs, and can be turned off', async () => {
    const files = {
      'content/index.md':
        '# Home\n\n<img src="blue.png" alt="Sized" width="10" height="5">\n\n![Vector](v.svg)\n',
      'content/blue.png': PNG,
      'content/v.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    };
    const { outDir } = await buildSite({ rootDir: tempProject(files), config: config() });
    const html = read(outDir, 'index.html');
    expect(html).toContain('alt="Sized" width="10" height="5"');
    expect(html).toContain('<img src="/v.svg" alt="Vector"');

    const off = await buildSite({
      rootDir: tempProject(files),
      config: config({ images: { optimize: false } }),
    });
    expect(read(off.outDir, 'index.html')).not.toContain('<picture>');
  });

  it('warns about images it cannot read and leaves them as they are', async () => {
    const result = await buildSite({
      rootDir: tempProject({
        'content/index.md': '# Home\n\n![Broken](x.jpg)\n',
        'content/x.jpg': 'not a jpeg',
      }),
      config: config(),
    });
    expect(result.diagnostics).toMatchObject([
      { ruleId: 'image-failed', severity: 'warning', file: 'content/index.md', line: 3 },
    ]);
    expect(read(result.outDir, 'index.html')).toContain('<img src="/x.jpg" alt="Broken"');
  });
});

describe('minification', () => {
  it('collapses whitespace but keeps preformatted text', async () => {
    const files = {
      'content/index.md': '# Home\n\n```\n  indented\n    more\n```\n\nSome *inline*  text.\n',
    };
    const { outDir } = await buildSite({ rootDir: tempProject(files), config: config() });
    const html = read(outDir, 'index.html');
    expect(html).not.toMatch(/>\n\s+</);
    expect(html).toContain('  indented\n');
    expect(html).toContain('Some <em>inline</em> text.');

    const readable = await buildSite({
      rootDir: tempProject(files),
      config: config({ build: { minify: false } }),
    });
    expect(read(readable.outDir, 'index.html')).toMatch(/>\n\s+</);
  });
});
