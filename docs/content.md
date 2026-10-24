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

Root-relative URLs (`/assets/site.css`) and absolute URLs are left as they are. Links to missing pages are reported as `link-broken` warnings.

**Images** are lazy-loaded. Missing alt text is an error. Empty alt text (`![](x.png)`) is a warning unless the image has `role="presentation"`.

**Video** uses image syntax with a video file: `![Product demo](demo.mp4)` becomes a `<video controls>` inside a `<figure>` with the alt text as its caption. If a WebVTT file with the same name exists (`demo.vtt`), it's added as a captions track. Otherwise a `video-captions` warning is reported (WCAG 1.2.2).

**Code blocks** with a language (` ```ts `) are highlighted with light and dark themes. Unknown languages render as plain text.

## HTML files

- An HTML **fragment** (no `<!doctype>` or `<html>`) is wrapped in the theme layout, like Markdown.
- A complete HTML **document** is published as it is. Only the theme's and the site's stylesheets and scripts are added to its `<head>`, and relative links are rewritten as above.
- A complete document **with front-matter** opts in to the theme: its `<body>` is wrapped in the layout.
