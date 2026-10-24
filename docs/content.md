# Content

## Project layout

| Directory    | Purpose                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------- |
| `content/`   | Pages (`.md`, `.markdown`, `.html`, `.htm`). Other files here are copied alongside the pages. |
| `assets/`    | Published at `/assets/`. Stylesheets and scripts for `styles`/`scripts` in the config.        |
| `static/`    | Copied verbatim to the site root (`static/robots.txt` → `/robots.txt`).                       |
| `templates/` | Overrides for theme layouts and partials (see [themes](themes.md)).                           |
| `data/`      | JSON/YAML files available to templates as `data.<file name>`.                                 |

Dot-files and `node_modules` are ignored everywhere.

## URLs

With the default `build.cleanUrls: true` and `build.trailingSlash: "always"`:

| Source                                              | URL            | Output file             |
| --------------------------------------------------- | -------------- | ----------------------- |
| `content/index.md`                                  | `/`            | `index.html`            |
| `content/about.md`                                  | `/about/`      | `about/index.html`      |
| `content/blog/index.md` or `content/blog/_index.md` | `/blog/`       | `blog/index.html`       |
| `content/blog/hello.md`                             | `/blog/hello/` | `blog/hello/index.html` |
| `content/404.md`                                    | `/404.html`    | `404.html`              |

`slug:` in the front-matter replaces the file name part of the URL. With `trailingSlash: "never"`, `about.md` becomes `/about` (`about.html`). With `cleanUrls: false`, it becomes `/about.html`.

## Front-matter

A YAML block at the very top of a Markdown or HTML file, between `---` lines:

```yaml
---
title: Hello, world # page title (else the leading # heading, else the file name)
description: Short summary for search results and link previews
layout: post # theme layout (default: the theme's defaultLayout)
date: 2026-10-24
updated: 2026-10-30
tags: [news, aws]
draft: true # left out of builds unless --drafts
slug: hello # overrides the URL segment
lang: el # page language (default: site.language)
order: 3 # position in collections with sortBy: order
sitemap: false # leave out of sitemap.xml
nav:
  order: 1 # position in the main navigation; also opts deeper pages in
  label: Home # navigation text (default: title)
  hide: true # leave out of the navigation
---
```

Other keys are kept and available to templates as `page.data.<key>`. Invalid values are reported as `frontmatter-invalid` errors and ignored.

## Links and media

Write links and image paths relative to the source file, as your editor sees them. staticforge rewrites them for the built site:

| You write (in `content/blog/post.md`) | Published as        |
| ------------------------------------- | ------------------- |
| `[Next](other.md#part)`               | `/blog/other/#part` |
| `![Chart](chart.png)`                 | `/blog/chart.png`   |
| `![Logo](../../assets/logo.svg)`      | `/assets/logo.svg`  |
| `[CV](../../static/cv.pdf)`           | `/cv.pdf`           |

Root-relative URLs (`/assets/site.css`) and absolute URLs are left as they are. Links to Markdown sources that match no page are reported as `link-broken` warnings by the build; `sforge check` verifies every other internal link, image and asset against the built site (see [checker.md](checker.md)).

**Images** are lazy-loaded. Missing alt text is an error. Empty alt text (`![](x.png)`) is a warning unless the image has `role="presentation"`. JPEG, PNG, WebP and AVIF images in content are made responsive; see [Images](#images).

**Video** uses image syntax with a video file: `![Product demo](demo.mp4)` becomes a `<video controls>` inside a `<figure>` with the alt text as its caption. If a WebVTT file with the same name exists (`demo.vtt`), it's added as a captions track. Otherwise a `video-captions` warning is reported (WCAG 1.2.2).

**Code blocks** with a language (` ```ts `) are highlighted with light and dark themes. Unknown languages render as plain text.

## HTML files

- An HTML **fragment** (no `<!doctype>` or `<html>`) is wrapped in the theme layout, like Markdown.
- A complete HTML **document** is published as it is. Only the theme's and the site's stylesheets and scripts are added to its `<head>`, and relative links are rewritten as above.
- A complete document **with front-matter** opts in to the theme: its `<body>` is wrapped in the layout.

## Collections, tags and feeds

A collection is a directory of pages listed together, such as a blog:

```ts
collections: {
  blog: { dir: 'content/blog', sortBy: 'date', perPage: 10, feed: { rss: true, atom: true } },
},
```

- **Members** are the pages under `dir`, at any depth, except section index pages
  (`_index.md`, `index.md`). They use the theme's `post` layout unless they set a `layout`.
- **Sorting**: `date` (newest first, undated pages last), `title`, or `order` (front-matter
  `order`, ascending).
- **List pages**: the collection's index page (`content/blog/_index.md`, with the `list` layout)
  shows its own content and the first `perPage` members; later pages are generated at
  `/blog/page/2/`, `/blog/page/3/`, …. Without an index page, `/blog/` is generated too.
- **Feeds**: `/blog/feed.xml` (RSS 2.0) and `/blog/atom.xml` (Atom) carry the 20 newest members
  with their full content, and every page links to them for feed readers to discover.
- **Tags** from front-matter get a page each at `/tags/<slug>/`, and `/tags/` lists them all
  (slugs: `Release Notes` → `release-notes`). A content page at `content/tags/index.md` replaces
  the generated list.

Templates see every collection as `collections.<name>`; see [themes.md](themes.md#template-context).

## Images

Content images in JPEG, PNG, WebP or AVIF become a `<picture>`: AVIF and WebP versions
(`images.formats`) and the original format as a fallback, each at the configured widths
(`images.widths`, default 480, 960 and 1600 pixels) up to the image's own width. The `<img>` gets
`width` and `height`, so the page doesn't shift while it loads, and `sizes` from `images.sizes`.

```ts
images: { formats: ['avif', 'webp'], widths: [480, 960, 1600], quality: 75, sizes: '(min-width: 45rem) 45rem, 100vw' },
```

- Variants are published under `/_assets/img/` with a hash of the image in their names, and cached
  in `.sforge/cache/` (add it to `.gitignore`), so unchanged images aren't encoded again.
- Images an author has sized (`width`/`height`) keep that size; an existing `<picture>` or
  `srcset` is left alone. SVG and GIF images, and images in complete HTML documents, are not changed.
- `images: { optimize: false }` turns this off. An image that can't be read is published as it is
  with an `image-failed` warning.

## Stylesheets and scripts

Every `.css` file in `assets/` (and the theme's) is bundled with its `@import`s by
[Lightning CSS](https://lightningcss.dev/), prefixed and lowered for current browsers, and minified.
Every `.js` and `.ts` file is bundled with its imports by [esbuild](https://esbuild.github.io/) as an
ES module (TypeScript is compiled; `.ts` files are published as `.js`). Root-relative and remote
imports (`import('/pagefind/pagefind.js')`) are left for the browser.

Each file is published under its own name and under a content-hashed one
(`/assets/css/site.3f2a9c1b.css`); pages reference the hashed name, so it can be cached forever.
References in content (`<link href="/assets/css/site.css">`) are rewritten too. `build.minify: false`
keeps output readable; `sforge dev` never hashes or minifies.

HTML is minified as well: whitespace between elements is collapsed, except in `<pre>`,
`<textarea>` and inline text.

## Search

With `search.enabled` (the default), the build indexes every page with
[Pagefind](https://pagefind.app/) into `/pagefind/`, and the default theme adds a search page at
`/search/` with a link in the header. Search runs in the browser; there is no server. Only content
marked `data-pagefind-body` is indexed (the default theme marks page and post bodies).

## Sitemap and robots.txt

`/sitemap.xml` lists every page except the 404 page, the search page and pages with
`sitemap: false`, with `updated` or `date` as the last modification. `/robots.txt` allows everything
and points to the sitemap, unless the project has its own `static/robots.txt`.
