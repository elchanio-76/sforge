# Writing content for a staticforge site

## URLs

With the defaults (`build.cleanUrls: true`, `build.trailingSlash: "always"`):

| Source                                              | URL            |
| --------------------------------------------------- | -------------- |
| `content/index.md`                                  | `/`            |
| `content/about.md`                                  | `/about/`      |
| `content/blog/index.md` or `content/blog/_index.md` | `/blog/`       |
| `content/blog/hello.md`                             | `/blog/hello/` |
| `content/404.md`                                    | `/404.html`    |

`slug:` replaces the file-name part of the URL. With `trailingSlash: "never"`, `about.md` is
`/about`; with `cleanUrls: false`, `/about.html`. Check the config before writing root-relative
links by hand; better, link to the source file and let sforge produce the URL.

## Front-matter

YAML between `---` lines at the very top of a `.md` or `.html` file. All keys are optional.

```yaml
---
title: Getting started # the page's <h1> and <title>; else the leading # heading, else the file name
description: One-sentence summary for search results and link previews
layout: post # a theme layout; default from the theme (usually page)
date: 2026-10-24 # posts: sorting, feeds, sitemap
updated: 2026-10-30
tags: [news, aws] # each tag gets /tags/<slug>/
draft: true # left out unless drafts: true
slug: hello # replaces the URL segment
lang: el # page language (default site.language)
order: 3 # position in collections with sortBy: order
sitemap: false # leave out of sitemap.xml
nav:
  order: 1 # position in the main navigation (also opts deeper pages in)
  label: Home # navigation text (default: title)
  hide: true # leave out of the navigation
---
```

Other keys are kept for templates as `page.data.<key>`. Invalid values become
`frontmatter-invalid` errors and are ignored; malformed YAML is `frontmatter-yaml`.

Always give pages a `description`: it feeds the meta description, social cards and feeds.

## Headings

The layout prints `title` as the page's single `<h1>`. A leading `# Heading` in Markdown is moved
into the title; any other `#` heading is demoted (`heading-shift` notice). So: start the body at
`##`, go down one level at a time (`##` → `###`, never `##` → `####`).

## Links and media

Write paths relative to the source file. sforge rewrites them:

| In `content/blog/post.md`        | Published as        |
| -------------------------------- | ------------------- |
| `[Next](other.md#part)`          | `/blog/other/#part` |
| `![Chart](chart.png)`            | `/blog/chart.png`   |
| `![Logo](../../assets/logo.svg)` | `/assets/logo.svg`  |
| `[CV](../../static/cv.pdf)`      | `/cv.pdf`           |

Root-relative (`/assets/site.css`) and absolute URLs are left alone. A link to a `.md` file that
is not a page is `link-broken`; `sforge_check` verifies every other internal link, image, script,
stylesheet and media file against the built site, and `#fragment` targets (`link-fragment`).

- **Images**: put them next to the page (or in `assets/`). JPEG, PNG, WebP and AVIF become
  responsive `<picture>` elements automatically; do not hand-write `srcset`. Alt text is
  required: describe what the image conveys in context, in one sentence, without "image of".
  `alt=""` only for purely decorative images (that is a warning unless `role="presentation"`).
- **Video**: `![Product demo](demo.mp4)` becomes `<video controls>` in a `<figure>` with the alt
  text as its caption. Put `demo.vtt` (WebVTT captions) beside it, or `video-captions` warns.
- **Code blocks**: give the language (` ```ts `) for highlighting.
- **Tables and code** scroll sideways on their own; give tables a caption when they need a name.
- **Links that open a new tab** (`target="_blank"`) get "(opens in a new tab)" added for screen
  readers automatically.
- **iframes** need a `title` (`iframe-title`, error).

## HTML files

- An HTML fragment (no `<!doctype>`/`<html>`) is wrapped in the theme layout like Markdown.
- A complete HTML document is published as is (plus the site's styles and scripts); it must have
  its own `lang`, `<title>`, landmarks and skip link. Adding front-matter to it opts its
  `<body>` into the layout instead.

## Collections, tags and feeds

A collection is configured, not inferred:

```ts
collections: {
  blog: { dir: 'content/blog', sortBy: 'date', perPage: 10, feed: { rss: true, atom: true } },
},
```

- Members are the pages under `dir` except `index.md`/`_index.md`. They use the `post` layout
  unless they set `layout`.
- The index page (`content/blog/_index.md`) lists the members; extra pages appear at
  `/blog/page/2/`, ….
- Feeds at `/blog/feed.xml` and `/blog/atom.xml`.
- `sforge_new_page` with `kind: "post"` and a bare name (`path: "hello-world"`) creates
  `content/blog/hello-world.md` with today's date.

## Drafts

`draft: true` pages are left out of builds, checks and deploys unless `drafts: true` is passed
(`sforge_build`, `sforge_check`, `sforge_dev_start`) or `build.drafts` is set. A draft is
therefore invisible to the check by default: pass `drafts: true` when checking one.

## Styles, scripts and templates

- Stylesheets and scripts go in `assets/` and are listed in the config as root-relative URLs:
  `styles: ['/assets/css/site.css']`, `scripts: ['/assets/js/site.js']`. They are bundled,
  minified and fingerprinted. TypeScript is compiled.
- To change the page frame, copy the theme's file to the same path under `templates/`
  (`templates/partials/footer.njk`) and edit it there. A new layout
  (`templates/layouts/gallery.njk`) is selected with `layout: gallery`. Templates are Nunjucks
  with autoescaping; output the body with `{{ content | safe }}`; reference assets with the
  `asset` filter (`{{ "/assets/js/app.js" | asset }}`) so they get the fingerprinted name.
- Theme changes must keep the accessibility contract: `lang` on `<html>`, a `<title>`, a
  viewport that allows zoom, `<header>`, labelled `<nav>`, `<main id="main">`, `<footer>`, a skip
  link to `#main` first, one `<h1>`, `aria-current="page"` in navigation, visible focus styles,
  and 4.5:1 text contrast in light and dark color schemes.

## Search, sitemap, robots

Search (Pagefind) is on by default and indexes elements marked `data-pagefind-body`; the default
theme adds `/search/`. `/sitemap.xml` lists pages except 404, search and `sitemap: false`.
`/robots.txt` is generated unless `static/robots.txt` exists.
