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
  "layouts": ["page", "post", "404"],
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

A `404` layout, if present, renders `/404.html`. It's used for `content/404.md`, or for a generated page when the site has none.

## Overriding templates in a project

Files in the project's `templates/` directory take precedence over the theme's, using the same paths. For example, `templates/partials/footer.njk` replaces the theme footer, and `templates/layouts/gallery.njk` adds a `gallery` layout that pages can select with `layout: gallery`.

## Template context

Templates are rendered with autoescaping on. Output the page body with `{{ content | safe }}`.

| Variable                                                                         | Description                                                                          |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `site.title`, `site.description`, `site.author`, `site.language`, `site.baseUrl` | From the config.                                                                     |
| `page.title`                                                                     | Front-matter `title`, the leading `#` heading, or a name derived from the file name. |
| `page.description`                                                               | Front-matter `description`.                                                          |
| `page.url`                                                                       | Root-relative URL, e.g. `/blog/hello/`.                                              |
| `page.absoluteUrl`                                                               | `page.url` resolved against the base URL (for canonical and Open Graph tags).        |
| `page.lang`                                                                      | Front-matter `lang`, or `site.language`.                                             |
| `page.date`, `page.updated`                                                      | `Date` values from the front-matter, or undefined.                                   |
| `page.tags`                                                                      | Array of strings.                                                                    |
| `page.layout`                                                                    | The layout being rendered.                                                           |
| `page.headings`                                                                  | `{ depth, id, text }` for each heading below the title, for tables of contents.      |
| `page.data`                                                                      | All front-matter, including keys staticforge doesn't define.                         |
| `content`                                                                        | The page body as HTML.                                                               |
| `nav`                                                                            | Array of `{ title, url, current, active }` for the main navigation.                  |
| `theme.styles`, `theme.scripts`                                                  | URLs of stylesheets and scripts to include (theme's, then the site's).               |
| `data`                                                                           | The project's `data/*.json` and `data/*.yaml` files, keyed by file name.             |
| `build.generator`, `build.time`, `build.year`                                    | Build information.                                                                   |

### Filters

| Filter               | Example                                      | Output                         |
| -------------------- | -------------------------------------------- | ------------------------------ |
| `absoluteUrl`        | `{{ "/feed.xml" \| absoluteUrl }}`           | `https://example.com/feed.xml` |
| `isoDate`            | `{{ page.date \| isoDate }}`                 | `2026-10-24`                   |
| `readableDate(lang)` | `{{ page.date \| readableDate(page.lang) }}` | `October 24, 2026`             |

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
- Stable `data-testid` hooks on major components (`main`, `site-nav`, `site-header`, `site-footer`, `skip-link`) for headless tests.
