# Themes

A theme is a directory with a `theme.json` manifest, Nunjucks layouts and partials, and static assets:

```
my-theme/
  theme.json
  layouts/        # page.njk, post.njk, 404.njk, …
  partials/       # header.njk, nav.njk, footer.njk, …
  assets/         # published at /assets/theme/
    css/theme.css
```

Set `theme` in the config to `"default"` (the bundled theme), a directory path such as `"./themes/my-theme"`, or the name of an installed npm package that contains a `theme.json`.

## theme.json

```json
{
  "name": "my-theme",
  "version": "1.0.0",
  "defaultLayout": "page",
  "layouts": ["page", "post", "list", "tag", "tags", "search", "404"],
  "styles": ["css/theme.css"],
  "scripts": []
}
```

| Key             | Meaning                                                                  |
| --------------- | ------------------------------------------------------------------------ |
| `layouts`       | Layout names; each must exist as `layouts/<name>.njk`.                   |
| `defaultLayout` | Used when a page has no `layout` in its front-matter. Default `page`.    |
| `styles`        | Stylesheets under `assets/`, linked on every page before the site's own. |
| `scripts`       | ES modules under `assets/`, loaded on every page before the site's own.  |

Some layouts have special roles. A theme that leaves one out simply doesn't get the pages it renders:

| Layout   | Renders                                                                                 |
| -------- | --------------------------------------------------------------------------------------- |
| `post`   | Members of a collection that set no `layout`.                                           |
| `list`   | A collection's index page and generated list pages, with `pagination`.                  |
| `tag`    | `/tags/<slug>/` for each tag, with `tag`.                                               |
| `tags`   | `/tags/`, listing `tags`.                                                               |
| `search` | `/search/` when `search.enabled`; the search UI is the theme's (see [Search](#search)). |
| `404`    | `/404.html`, for `content/404.md` or a generated page when the site has none.           |

## Overriding templates in a project

Files in the project's `templates/` directory take precedence over the theme's, using the same paths. For example, `templates/partials/footer.njk` replaces the theme footer, and `templates/layouts/gallery.njk` adds a `gallery` layout that pages can select with `layout: gallery`.

## Template context

Templates are rendered with autoescaping on. Output the page body with `{{ content | safe }}`.

| Variable                                                                         | Description                                                                                                                         |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `site.title`, `site.description`, `site.author`, `site.language`, `site.baseUrl` | From the config.                                                                                                                    |
| `page.title`                                                                     | Front-matter `title`, the leading `#` heading, or a name derived from the file name.                                                |
| `page.description`                                                               | Front-matter `description`.                                                                                                         |
| `page.url`                                                                       | Root-relative URL, e.g. `/blog/hello/`.                                                                                             |
| `page.absoluteUrl`                                                               | `page.url` resolved against the base URL (for canonical and Open Graph tags).                                                       |
| `page.lang`                                                                      | Front-matter `lang`, or `site.language`.                                                                                            |
| `page.date`, `page.updated`                                                      | `Date` values from the front-matter, or undefined.                                                                                  |
| `page.tags`                                                                      | Array of strings.                                                                                                                   |
| `page.tagLinks`                                                                  | `{ name, slug, url }` for each tag; `url` is the tag page (undefined without a `tag` layout).                                       |
| `page.collection`                                                                | Name of the collection the page belongs to, or undefined.                                                                           |
| `page.layout`                                                                    | The layout being rendered.                                                                                                          |
| `page.headings`                                                                  | `{ depth, id, text }` for each heading below the title, for tables of contents.                                                     |
| `page.data`                                                                      | All front-matter, including keys staticforge doesn't define.                                                                        |
| `content`                                                                        | The page body as HTML.                                                                                                              |
| `nav`                                                                            | Array of `{ title, url, current, active }` for the main navigation.                                                                 |
| `theme.styles`, `theme.scripts`                                                  | URLs of stylesheets and scripts to include (theme's, then the site's).                                                              |
| `data`                                                                           | The project's `data/*.json` and `data/*.yaml` files, keyed by file name.                                                            |
| `build.generator`, `build.time`, `build.year`                                    | Build information. Under `sforge dev`, `build.time` is the server's start time, so unchanged pages stay identical between rebuilds. |
| `collections.<name>`                                                             | The collection's pages, sorted: `{ title, url, absoluteUrl, description, date, updated, tags }`.                                    |
| `pagination`                                                                     | On list pages: `{ collection, page, pages, total, items, first, last, prev, next }`.                                                |
| `tags`, `tagsUrl`                                                                | Every tag as `{ name, slug, url, count }`, and the URL of the tag index.                                                            |
| `tag`                                                                            | On tag pages: the tag, with `items` (its pages, newest first).                                                                      |
| `breadcrumbs`                                                                    | `{ title, url, current }` for home, ancestor pages and the page.                                                                    |
| `feeds`                                                                          | `{ type, title, url }` of the collection feeds, for `<link rel="alternate">`.                                                       |
| `search`                                                                         | `{ url }` of the search page, or undefined when search is off.                                                                      |

### Filters

| Filter               | Example                                      | Output                         |
| -------------------- | -------------------------------------------- | ------------------------------ |
| `absoluteUrl`        | `{{ "/feed.xml" \| absoluteUrl }}`           | `https://example.com/feed.xml` |
| `isoDate`            | `{{ page.date \| isoDate }}`                 | `2026-10-24`                   |
| `readableDate(lang)` | `{{ page.date \| readableDate(page.lang) }}` | `October 24, 2026`             |
| `asset`              | `{{ "/assets/js/app.js" \| asset }}`         | `/assets/js/app.1a2b3c4d.js`   |
| `themeAsset`         | `{{ "js/search.js" \| themeAsset }}`         | `/assets/theme/js/search.….js` |

Use `asset` and `themeAsset` for files a template references directly, so it gets the
fingerprinted name. `theme.styles` and `theme.scripts` already have them.

## Accessibility contract

`sforge check` (M3) verifies these on every page, so themes should provide them:

- `<html lang="{{ page.lang }}">`, a `<title>`, and `<meta name="viewport">` that doesn't block zooming.
- Landmarks: `<header>`, `<nav aria-label="…">`, `<main id="main">` and `<footer>`.
- A skip link to `#main` as the first focusable element.
- Exactly one `<h1>`: the layout renders `page.title`, and content headings start at `<h2>`. staticforge moves a leading `#` heading into `page.title` and demotes any other content `<h1>`s.
- `aria-current="page"` on the navigation link for the current page.
- A `.visually-hidden` class. staticforge uses it for "(opens in a new tab)" text on `target="_blank"` links.
- Text contrast of at least 4.5:1 and UI contrast of at least 3:1 in every color scheme, a visible `:focus-visible` style, and respect for `prefers-reduced-motion`.
- Styles for Shiki's code highlighting variables: `--shiki-light`, `--shiki-dark`, `--shiki-light-bg` and `--shiki-dark-bg`.
- Sideways scrolling for wide content: staticforge wraps every content table in `<div class="table-scroll" tabindex="0">` (a named `role="region"` when the table has a caption) and gives code blocks `tabindex="0"`, so keyboard users can scroll them (WCAG 2.1.1). Let `.table-scroll` and `pre` scroll (`overflow-x: auto`) rather than the table itself: `display: block` on a table removes its table semantics in some screen readers.
- Stable `data-testid` hooks on major components (`main`, `site-nav`, `site-header`, `site-footer`, `skip-link`, `breadcrumbs`, `pagination`, `page-list`, `search-form`, `search-results`) for headless tests.
- Distinct `aria-label`s when a page has several `<nav>`s (the default theme: Main, Breadcrumb, Pagination).

## Search

The build writes a [Pagefind](https://pagefind.app/) index to `/pagefind/`, covering elements marked
`data-pagefind-body` (mark the main content of page-like layouts; leave lists and the 404 page
unmarked). The `search` layout provides the UI. The default theme's is a form with a labelled
input, a `role="status"` line that announces the number of results, and a list of results, loaded
by `assets/js/search.js`:

```js
const pagefind = await import('/pagefind/pagefind.js');
const { results } = await pagefind.search(query);
const pages = await Promise.all(results.slice(0, 20).map((r) => r.data())); // { url, meta.title, excerpt }
```

Pagefind's own UI (`/pagefind/pagefind-ui.js` and `.css`) is published too, for themes that prefer it.
