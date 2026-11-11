# Diagnostics: what each rule means and how to fix it

Every diagnostic has `ruleId`, `severity` (`error`, `warning`, `info`) and `message`, and where
known `file`, `line`, `column`, `url`, `selector`, `wcag`, `fixable`, `hint` and `helpUrl`.
`data.ok` is false when any problem is at or above `check.failOn` (default `error`).

## Where a problem comes from

| Layer    | Located by                               | Usually caused by                   |
| -------- | ---------------------------------------- | ----------------------------------- |
| build    | `file`, `line`, `column`                 | the content source itself           |
| source   | `file`, `line`, `column`                 | the content source; often `fixable` |
| output   | `url`, `selector` (+ `file` of the page) | content, or the theme               |
| rendered | `url`, `selector` (+ `file`)             | content, theme CSS or a script      |

Output and rendered problems name the page's source as `file`, but the element may come from the
theme or a template override. **If the same `ruleId` and `selector` appear on many pages, the
cause is a template** (`templates/` or the theme), not each page. Fix it once there. Rendered
problems found in only some viewports say so in the message, e.g. "(dark only)" or "(mobile
only)": look at the dark-scheme CSS or the narrow layout.

## Rules

| Rule                                 | Sev.          | Fix                                                                                                                                                                                                                                                                            |
| ------------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `img-alt`                            | error         | Write alt text that says what the image conveys here; `alt=""` only for decoration. Never invent it from the file name; ask the user if you cannot tell.                                                                                                                       |
| `link-broken`                        | error         | The target is not in the built site. Check the relative path from the source file, the file's existence, a draft target (built only with `drafts`), or a `.md` link to something that is not a page.                                                                           |
| `link-fragment`                      | warning       | The `#id` does not exist on the target. Heading ids are slugs of the heading text (`## Getting started` → `#getting-started`).                                                                                                                                                 |
| `link-trailing-slash`                | warning       | Fixable. Link to the canonical URL (`/about/`, not `/about`), or better, to the source file.                                                                                                                                                                                   |
| `link-outside-site`                  | warning       | The reference points outside `content/`, `assets/` and `static/`; move the file into one of them.                                                                                                                                                                              |
| `heading-order`                      | warning       | Fixable in Markdown. Do not skip levels; the fix keeps the outline's shape.                                                                                                                                                                                                    |
| `heading-shift`                      | info          | An extra `#` heading was demoted because the layout owns the `<h1>`. Start body headings at `##`.                                                                                                                                                                              |
| `heading-depth`                      | warning       | A heading would go below `<h6>`; flatten the outline.                                                                                                                                                                                                                          |
| `page-title`                         | warning       | Add `title:` to the front-matter (or a leading `# Heading`).                                                                                                                                                                                                                   |
| `document-title`                     | error         | Fixable for complete HTML documents: add a `<title>`.                                                                                                                                                                                                                          |
| `html-lang`                          | error         | Fixable for complete HTML documents: add `lang` to `<html>`.                                                                                                                                                                                                                   |
| `frontmatter-yaml`                   | error         | The YAML between `---` lines does not parse, or is not a mapping. Quote values with `:` or `#`.                                                                                                                                                                                |
| `frontmatter-invalid`                | error         | A known key has the wrong type (e.g. `tags` not a list, `date` not a date).                                                                                                                                                                                                    |
| `layout-missing`                     | error         | `layout:` names a layout the theme lacks; use one it has or add `templates/layouts/<name>.njk`.                                                                                                                                                                                |
| `output-conflict`                    | error         | Two sources produce the same URL (e.g. `about.md` and `about/index.md`, or a `slug` clash). Rename one.                                                                                                                                                                        |
| `asset-missing`                      | error         | A `styles`/`scripts` URL in the config has no file in `assets/` (or `static/`).                                                                                                                                                                                                |
| `asset-failed`, `asset-warning`      | error/warning | CSS or JS failed to bundle; the message has the bundler's error.                                                                                                                                                                                                               |
| `image-failed`                       | warning       | An image could not be read for resizing and was published as is. Check the file.                                                                                                                                                                                               |
| `video-captions`                     | warning       | Add a WebVTT file with the video's name (`demo.vtt` beside `demo.mp4`).                                                                                                                                                                                                        |
| `video-controls`                     | warning       | An autoplaying video needs controls (or no autoplay).                                                                                                                                                                                                                          |
| `iframe-title`                       | error         | Add `title="…"` describing the embedded content.                                                                                                                                                                                                                               |
| `meta-viewport`                      | error         | The viewport blocks zoom (`user-scalable=no`, `maximum-scale`); remove that. A missing viewport is a warning. Usually a template or a complete HTML document.                                                                                                                  |
| `landmark-main`                      | warning       | The page has no `<main>`; usually a complete HTML document or a custom layout.                                                                                                                                                                                                 |
| `skip-link`                          | warning       | Pages with a header or nav must start with a link to `#main`; a layout issue.                                                                                                                                                                                                  |
| `script-error`                       | error         | A page script threw in Chromium; the message has the error. Fix the script in `assets/`.                                                                                                                                                                                       |
| `headless-skipped`                   | warning       | Rendered checks did not run (no Chromium). Not a site problem; see SKILL.md Limitations.                                                                                                                                                                                       |
| `render-failed`                      | error         | A Nunjucks template failed; the message names the template and line.                                                                                                                                                                                                           |
| `collection-invalid`, `data-invalid` | error         | A collection's `dir` or a `data/` file is wrong; the message says what.                                                                                                                                                                                                        |
| `html/…`                             | varies        | html-validate: invalid or inaccessible markup. `helpUrl` explains the rule; fix the markup in content or template.                                                                                                                                                             |
| `axe/…`                              | varies        | axe-core in Chromium (`critical`/`serious` are errors). Common: `axe/color-contrast` (fix the CSS colors, in both color schemes), `axe/label` (form controls need a `<label>`), `axe/link-name` and `axe/button-name` (give icon-only links and buttons text or `aria-label`). |

When html-validate or axe-core report something a rule above covers, it appears under that rule's
id (axe's `image-alt` is `img-alt`), so one problem has one id.

## Automatic fixes

`sforge_fix_preview` returns the diff (`data.fixes.diff`); `sforge_check` with `fix: true`
applies it and reports `data.fixes.files` (`file`, `ruleIds`). Only four rules are fixed, only in
content sources: `html-lang`, `document-title`, `heading-order` (Markdown), `link-trailing-slash`.
Everything else is yours to fix.

## Ignoring a rule

`check.ignore` in the config takes rule ids, with a trailing `*` for a prefix
(`'html/no-implicit-button-type'`, `'axe/*'`). Changing it lowers the site's bar: suggest it to
the user with the reason, do not add it to make a check pass.
