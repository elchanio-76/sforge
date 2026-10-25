# Checking a site

`sforge check` builds the site into a temporary directory (never `dist/`) and checks it for
accessibility (WCAG 2.2 AA by default) and correctness. It exits with code 1 when it finds
problems at or above `check.failOn` (`error` by default).

```sh
sforge check                       # everything, including headless Chromium checks
sforge check --no-headless         # static checks only (fast; no browser needed)
sforge check --pages "/blog/**"    # only some pages (URL or source globs)
sforge check --fix --dry-run       # show the safe fixes as a diff
sforge check --fix                 # apply them to the source files, then check again
sforge check --format sarif --output check.sarif   # for GitHub code scanning
sforge check --json                # the report in the --json envelope, for agents
```

`sforge dev` runs the static checks after every rebuild and shows the current page's problems
in its overlay.

## How it checks

Each problem is reported once, by the most precise layer that finds it:

| Layer        | Runs on                    | Finds                                                                                  | Location                     |
| ------------ | -------------------------- | -------------------------------------------------------------------------------------- | ---------------------------- |
| **build**    | content sources            | front-matter errors, image alt text, video captions, broken links to pages             | source file, line and column |
| **source**   | content sources            | the problems `--fix` can repair (below)                                                | source file, line and column |
| **output**   | the built HTML             | staticforge's output rules and [html-validate](https://html-validate.org/) (`html/…`)  | page URL and CSS selector    |
| **rendered** | pages in headless Chromium | [axe-core](https://github.com/dequelabs/axe-core) (`axe/…`) and uncaught script errors | page URL and CSS selector    |

Output and rendered problems name the source file of the page they appear on (`file`) and the
page URL (`url`). Their cause may be the page's content or the theme; a problem that appears at
the same element on several pages is listed once in the human report, as it is most likely the
theme's.

The rendered checks load every page three times: a desktop viewport in the light and in the dark
color scheme, and a mobile viewport. A problem found in only some of them says so, e.g.
"(dark only)". axe-core runs the rules tagged for the configured `check.wcag` level.

## Rules

| Rule                  | Severity | WCAG   | Fixable                     | What it checks                                                          |
| --------------------- | -------- | ------ | --------------------------- | ----------------------------------------------------------------------- |
| `html-lang`           | error    | 3.1.1  | yes (HTML documents)        | `<html>` has a `lang`                                                   |
| `document-title`      | error    | 2.4.2  | yes (HTML documents)        | the page has a non-empty `<title>` (the fix uses the `<h1>`)            |
| `heading-order`       | warning  | 1.3.1  | yes (Markdown `#` headings) | no heading skips a level                                                |
| `link-trailing-slash` | warning  |        | yes                         | links use the page's canonical URL rather than one that redirects to it |
| `link-broken`         | error    |        |                             | links, images, scripts, stylesheets and media exist in the built site   |
| `link-fragment`       | warning  |        |                             | `#fragment` targets exist on the linked page                            |
| `img-alt`             | error    | 1.1.1  |                             | images have alt text (`alt=""` for decorative images)                   |
| `video-captions`      | warning  | 1.2.2  |                             | videos have a captions track                                            |
| `iframe-title`        | error    | 4.1.2  |                             | iframes have a title                                                    |
| `meta-viewport`       | error    | 1.4.4  |                             | zooming is not disabled (a missing viewport is a warning, 1.4.10)       |
| `landmark-main`       | warning  | 1.3.1  |                             | the page has a `<main>` landmark                                        |
| `skip-link`           | warning  | 2.4.1  |                             | pages with a header or nav start with a link to the main content        |
| `script-error`        | error    |        |                             | page scripts run without uncaught errors (rendered checks)              |
| `headless-skipped`    | warning  |        |                             | rendered checks could not run (see [Chromium](#chromium))               |
| `html/…`              | varies   | varies |                             | html-validate's `standard`, `a11y` and `document` presets               |
| `axe/…`               | varies   | varies |                             | axe-core rules; `critical` and `serious` impacts are errors             |

Build diagnostics (`frontmatter-invalid`, `page-title`, `heading-shift`, …) are described in
[content.md](content.md). When html-validate or axe-core check the same thing as a rule above,
they report under that rule's ID (e.g. axe's `image-alt` as `img-alt`), so each problem has one ID.

## Fixes

`--fix` only makes changes that cannot alter what a page means, and only in content sources:

- adds `lang="<site.language>"` to `<html>` in HTML documents;
- adds a `<title>` (from the `<h1>`, or the file name) to HTML documents;
- changes the level of Markdown `#` headings that skip a level, keeping the outline's shape
  (`##`, `####`, `#####` becomes `##`, `###`, `####`);
- rewrites links that redirect (`/about` → `/about/`, or the reverse with `trailingSlash: never`).

It never writes alt text: describing an image takes a person who knows why it is there. Problems
in theme templates are not fixed automatically. `--fix --dry-run` prints a unified diff (and
puts it in `data.fixes.diff` with `--json`) without changing any file.

## Reports

- `pretty` (default): grouped by file, for people.
- `json`: the check result. With `--json` the same object is the envelope's `data`; its JSON
  Schema is `sforge schema diagnostics`.
- `sarif`: SARIF 2.1.0 for GitHub code scanning. Paths are relative to the git repository root.
- `junit`: JUnit XML; problems at or above `failOn` are failures.

`--output <file>` writes the report to a file and prints the human summary (or, with `--json`,
the envelope) to stdout.

## Configuration

```ts
check: {
  wcag: '2.2-AA',          // or '2.1-AA', '2.2-AAA'
  failOn: 'error',         // or 'warning'
  ignore: ['html/no-implicit-button-type', 'axe/*'],  // rule IDs; a trailing * matches a prefix
  headless: true,          // run the rendered checks
}
```

## Chromium

The rendered checks drive the Chromium build that matches the bundled Playwright version. Install
it once with the command `sforge check` prints when it is missing, e.g.

```sh
npx playwright-core@1.64.1 install --only-shell chromium
```

or set `SFORGE_CHROMIUM_PATH` to an existing Chrome or Chromium binary. When Chromium is missing,
`sforge check` skips the rendered checks with a `headless-skipped` warning, except with an explicit
`--headless` or in CI (`CI` set), where it fails with `SF_BROWSER_MISSING` (exit code 2) so a
pipeline never passes without them.

## In GitHub Actions

```yaml
- run: npx playwright-core@1.64.1 install --with-deps --only-shell chromium
- run: npx sforge check --format sarif --output check.sarif
- uses: github/codeql-action/upload-sarif@v4
  if: always()
  with:
    sarif_file: check.sarif
```

[`sforge ci init`](ci.md) writes this job (with pinned actions) as part of its workflows.
