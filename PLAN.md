# staticforge (`sforge`) — Implementation Plan

## Context
The repo (`/home/lchanio/projects/aws/static-site-generator`) is empty. The goal is a CLI-first static site generator that scripts and AI agents can drive. It:
- takes a **theme** (CSS + accessible layout templates) and **content** (Markdown or HTML, plus JS, images, video),
- builds well-formed, WCAG 2.2 AA–oriented HTML that headless tests can run against,
- checks the output with a built-in **checker** (`--fix` repairs what it safely can),
- serves a **localhost preview** with live reload,
- **provisions and deploys** to multiple providers: AWS (private S3 + CloudFront with OAC, never a public bucket) and Azure Static Web Apps,
- integrates with **GitHub Actions** CI/CD through OIDC (no long-lived secrets),
- exposes an **MCP server** and `--json` output so agents can use it.

Decisions made: TypeScript/Node; provision + deploy with **HCL modules run by OpenTofu (default) or Terraform**, remote state kept in each target's own cloud; theme = CSS + layouts; HTML fragments are wrapped and full documents pass through; WCAG 2.2 AA; GitHub Actions; optional custom domain; images optimized, video copied as is; navigation, sitemap, collections/RSS and search included; CLI + JSON + MCP; named environments, PR previews and rollback.

---

## 1. Tech stack
| Concern | Choice |
|---|---|
| Runtime / lang | Node `^22.22 \|\| >=24.8` (the floor html-validate 11 needs), TypeScript (strict), ESM |
| Monorepo | pnpm workspaces (pnpm 12, pinned via `packageManager`); `tsc -b` project references for builds (bundling deferred until publish) |
| Language version | TypeScript 6.0.x (typescript-eslint supports < 6.1; TypeScript 7 adopted once tooling supports it) |
| CLI | `commander` (subcommands), `zod` for config/flag validation |
| Config | `staticforge.config.ts` / `.json` / `.yaml` loaded with `c12` or custom loader; JSON Schema exported for editors/agents |
| Markdown → HTML | unified: `remark-parse`, `remark-gfm`, `remark-frontmatter`, `remark-rehype`, `rehype-slug`, `rehype-autolink-headings`, `shiki` (code highlight), `rehype-stringify` |
| HTML parse/transform | `rehype` / `hast` (same AST for MD and HTML input), `parse5` |
| Templates | Nunjucks (layouts, partials, filters) |
| Assets | `sharp` 0.35 (images → AVIF/WebP + original format, srcset, cached by content hash), `esbuild` 0.28 (JS/TS bundle/minify; esbuild's postinstall is denied in `pnpm-workspace.yaml`, its binary comes from the platform package), `lightningcss` (CSS bundle/prefix/minify for browserslist `defaults`), content-hash fingerprinting, `hast-util-minify-whitespace` for HTML |
| Search | Pagefind 1.5 via its Node API (`addHTMLFile` per finished page), own accessible UI in the default theme |
| Dev server | `node:http` static server + `chokidar` 5 watcher + Server-Sent Events live reload (no WebSocket dependency); each change builds into a new temp dir, reusing earlier results through content-hash caches (M8) |
| Parallelism | `node:worker_threads` through a small pool in `@staticforge/core` (no dependency): tasks name a module and an export, inputs and results are structured-cloned; from TypeScript sources (tests) workers strip types natively, with a resolve hook (`module.registerHooks`) mapping `.js` specifiers to `.ts` (M8) |
| Checker | `html-validate` 11 (`standard` + `a11y` + `document` presets), `axe-core` in headless Chromium driven by `playwright-core` (no browser download at install; `chromium-headless-shell` installed on demand), custom source and output rules (links, landmarks, headings, lang/title, media), `diff` for `--dry-run` |
| Provisioning (IaC) | **HCL modules** shipped in the package, run by **OpenTofu** (default; pinned 1.13.1, downloaded from GitHub releases and SHA-256-verified against checksums embedded in sforge, into `~/.cache/staticforge/bin`; tarball read in-process, no system `tar`) or **Terraform** ≥ 1.10 from PATH (`iac.engine`). Driven by spawning the CLI with `-json` output, which is parsed into progress events, plan summaries, drift and diagnostics |
| AWS runtime | AWS SDK v3 (`client-s3`, `client-cloudfront`, `client-cloudfront-keyvaluestore` with the pure-JS `signature-v4a` signer, `client-sts`, `client-iam`) for deploy, rollback, previews and provisioning lookups |
| Azure runtime | `@azure/arm-appservice` (Static Sites secrets/environments), `@azure/identity`, SWA content deploy via `@azure/static-web-apps-cli` deploy client |
| IaC quality | `tofu fmt -check`, `tofu test` with mocked providers (passes on OpenTofu 1.13 and Terraform 1.16), `validate` of the generated workspaces with both engines (`pnpm test:iac`); `tflint` and `checkov`/`trivy config` not added yet (left out of M8) |
| MCP | `@modelcontextprotocol/server` 2.x (the v2 SDK; `serveStdio` serves both the 2026-07-28 and the 2025 protocol eras), `zod` 4 for tool inputs |
| Tests | `vitest` (unit; workspace packages resolve to their sources through the private `@staticforge/source` export condition, renamed from `source` in M7 because third-party packages such as `eventsource` publish TypeScript under `source`), Playwright test (e2e preview + a11y), `aws-sdk-client-mock`, snapshot tests of built output, `ajv` (every `--json` envelope in the CLI tests is validated against `sforge schema output`), `@modelcontextprotocol/client` over an in-memory transport for the MCP server |
| Lint | ESLint + Prettier, `tsc --noEmit` |

## 2. Repository layout (pnpm monorepo)
```
packages/
  core/            # config, diagnostics type, logger, errors (no dependencies on other packages)
  content/         # front-matter, md→hast and html→hast, a11y transforms, fragment/document detection
  render/          # Nunjucks env, theme loader, layout resolution
  theme-default/   # accessible default theme (published package, resolved for theme: "default")
  build/           # discovery, routing, link resolution, orchestration, output + manifest, init/new scaffolding
  assets/          # image/js/css processing, fingerprinting, Pagefind indexing (pure functions; no knowledge of routes)
                   # site features (collections, tags, pagination, feeds, sitemap/robots, breadcrumbs) live in build/
                   # (site.ts, feeds.ts): they are tied to routing, so a separate site-features package was dropped (M4)
  server/          # static file server with production URL semantics (resolveRequest); used by dev, preview and the checker
  checker/         # source/output/rendered rules, de-duplication, autofixes, reporters (pretty/json/sarif/junit)
  dev-server/      # watcher, temp-dir builds, SSE live reload, problems overlay, preview
  providers/       # packages/providers/* (M5)
    provider-api/  # Provider interface + shared deploy logic (manifest diffing, cache classes, security headers, version ids)
    iac/           # engine resolver/downloader, workspace generator, tofu/terraform runner, state bootstrap, drift
    aws/           # IaC profile, deployer, versions, rollback, previews (SDK), CloudFront router rules
      terraform/   # HCL: modules/site (S3+OAC+CloudFront+KVS+router function+headers+ACM/Route 53+CI role+logs), state-bootstrap/
                   # (the certificate and CI role live in modules/site; separate cert/ci-oidc modules were dropped in M5)
    azure/         # (M6) deployer, previews, rollback (SDK)
      terraform/   # (M6) HCL: modules/site (SWA + domain), modules/ci-oidc (azuread), state-bootstrap/
  cli/             # `sforge` binary (commander), output formatting, exit codes, JSON Schemas of each command's data,
                   # and the MCP server (src/mcp/, M7): it runs the commands in process, so a separate mcp package
                   # would only have added an import cycle with the CLI
examples/
  basic-site/      # md + html + images + video + js; used by e2e tests
templates/
  github-actions/  # workflow templates emitted by `sforge ci init`
docs/
```

## 3. Project (user) structure and config
```
my-site/
  staticforge.config.ts
  content/        # .md, .html, nested dirs → URL paths; _index.md for section pages
  static/         # copied verbatim (favicon, robots overrides, videos, downloads)
  assets/         # served at /assets/; processed in M4 (images, js entrypoints, css)
  templates/      # project overrides of theme layouts/partials (same paths as the theme)
  data/           # JSON/YAML available to templates
  dist/           # build output (gitignored)
```
Config schema (zod → JSON Schema at `schema/staticforge.schema.json`):
```ts
{
  site: { title, baseUrl, language: 'en', description, author },
  theme: 'default' | './themes/mine' | 'some-npm-theme',
  styles: ['/assets/css/site.css'],   // linked after the theme's on every page
  scripts: ['/assets/js/site.js'],    // ES modules, after the theme's
  build: { outDir: 'dist', cleanUrls: true, trailingSlash: 'always'|'never', minify: true, drafts: false },
  images: { formats: ['avif','webp'], widths: [480, 960, 1600], quality },
  collections: { blog: { dir: 'content/blog', sortBy: 'date', perPage: 10, feed: { rss: true, atom: true } } },
  search: { enabled: true },
  check: { wcag: '2.2-AA', failOn: 'error', ignore: [ruleIds], headless: true },
  security: { contentSecurityPolicy, hsts: { maxAge, includeSubDomains, preload } | false, referrerPolicy, frameOptions, permissionsPolicy },
  iac: { engine: 'tofu' | 'terraform', version?, vendor: false, name? },
  targets: {
    staging: { provider: 'aws', region: 'eu-central-1', domain?: 'staging.example.com', hostedZone?: 'example.com', previewDomain?, retainVersions: 10, logging, wafWebAclArn?, state: { bucket?, region?, kmsKeyArn? }, ci? },
    prod:    { provider: 'azure', resourceGroup, location, sku: 'Free'|'Standard', domain? }
  }
}
```
Front-matter (YAML): `title` (required), `description`, `layout`, `date`, `tags`, `draft`, `nav: { order, label, hide }`, `lang`, `slug`, `og:*`.

## 4. Build pipeline (`packages/core`)
1. **Load & validate config** (zod). Errors carry machine codes (`SF_CONFIG_INVALID`).
2. **Discover** content/assets/static files → build a **content graph** (pages, sections, collections, assets, references).
3. **Parse** each page to HAST:
   - `.md` → unified pipeline (GFM, front-matter, slugs, heading anchors, shiki highlighting, footnotes). Custom plugins:
     - `rehype-a11y-images`: `![alt](src)` → `<picture>` with srcset, width/height, `loading="lazy"`, `decoding="async"`. Missing alt raises a diagnostic.
     - `rehype-video`: `![caption](x.mp4)` produces `<figure><video controls>` with `<figcaption>`, plus `<track kind="captions">` when a sibling `x.vtt` exists (implemented in M1; a `::video{}` directive is deferred).
     - `rehype-external-links`: `rel="noopener noreferrer"` and visually hidden "(opens in new tab)" text when the target is `_blank`.
     - `rehype-heading-shift`: content starts at h2 when the layout supplies h1 (only one h1 per page).
   - `.html` → parse5/rehype. **Detection**: a full document (has `<html>` or `<!doctype>`) passes through with the theme CSS and runtime assets injected into `<head>`. A fragment, or a full document with a YAML `---` front-matter header, is wrapped in a layout. parse5 reports tokenizer errors (duplicate attributes, bad entities) as `html-parse` warnings; tree-construction problems are reported by the checker (html-validate). GFM task-list checkboxes are wrapped in a `<label>` with their item text (M3), so they have an accessible name.
   - **Link resolution** (M1): references are written relative to the source file and rewritten for the built site: `other.md` → page URL, co-located files → root-relative, `../../assets/x` → `/assets/x`, `../../static/x` → `/x`. Broken page links → `link-broken` warnings.
4. **Render** with Nunjucks layouts: `base.njk` (doctype, `<html lang>`, meta charset/viewport, title, description, canonical, OG, skip link, landmarks `header/nav/main#main/footer`), plus `page`, `post`, `list`, `tag` layouts. Context: `page`, `site`, `nav`, `collections`, `data`, `assets()` helper.
5. **Site features** ✅ (M4, `packages/build/src/site.ts`, `feeds.ts`): top-level nav (dir structure + `nav.order`; `aria-current="page"`); breadcrumbs (home, ancestor pages, page; `nav aria-label="Breadcrumb"`, shown below the top level); **collections** (`collections.<name>.dir` under `content/`; members are pages below it except section indexes; default layout `post`; sorted by date (newest first), title or front-matter `order`; the dir index page is list page 1 with `pagination`, `/<dir>/page/N/` generated; `rel=prev/next`); **tags** (`/tags/<slug>/` with `tag`, `/tags/` with `tags`; a content page at `tags/index.md` wins); **feeds** per collection (`/<dir>/feed.xml` RSS 2.0 with `content:encoded`, `/<dir>/atom.xml`; 20 newest; root-relative URLs made absolute; autodiscovery links on every page); `sitemap.xml` (all pages but 404, search and `sitemap: false`; `lastmod` from `updated`/`date`); `robots.txt` unless `static/robots.txt` exists; `404.html`. The theme decides which generated pages exist by providing the layouts (`list`, `tag`, `tags`, `search`). Not done: a nested nav tree (top-level nav is enough so far).
6. **Assets** ✅ (M4, `@staticforge/assets`):
   - Every `.css` in `assets/` and the theme is bundled by lightningcss (`@import`s inlined, prefixes, minify); every `.js`/`.ts` by esbuild (ESM, es2022, `/…` and `https:` imports external). Each is written under its own name (`.ts` → `.js`; sources not published) **and** a content-hashed name in the same directory (so relative `url()`s keep working); page references (`theme.styles/scripts`, and any `href`/`src` in rendered HTML) are rewritten to the hashed name. Templates use the `asset` / `themeAsset` filters. Processing errors → `asset-failed`.
   - Content images (fragments only; complete documents are the author's) in JPEG/PNG/WebP/AVIF become `<picture>`: `images.formats` sources plus the original format, at `images.widths` capped by the intrinsic width, `sizes` from `images.sizes`, `width`/`height` from the (EXIF-rotated) intrinsic size unless the author set them. Author `srcset`/`<picture>`, SVG and GIF untouched. Variants at `/_assets/img/<name>-<hash>-<w>.<ext>`, cached in `<project>/.sforge/cache/images/` (atomic writes). Unreadable image → `image-failed` warning, left as is.
   - `sforge dev` builds with `fingerprint: false, minify: false`, so stylesheet URLs stay stable for the CSS hot-swap.
7. **Post-process** ✅ (M4): every page is re-parsed, asset references rewritten, whitespace minified when `build.minify` (`hast-util-minify-whitespace`: never inside `<pre>`, `<textarea>` or inline runs), and re-serialized. Pagefind indexes the finished pages (`data-pagefind-body` on page and post bodies) into `/pagefind/`; Pagefind's service is per process, so index writes are serialized. Pagefind needs WebAssembly: the M5 CSP must allow `'wasm-unsafe-eval'` on the search page.
8. **Write** `dist/` plus `dist/.sforge/build-manifest.json` (file → sha256, size, cache class: `immutable` for fingerprinted assets and image variants, `revalidate` for everything else). Deploy diffs use this manifest; content types are left to the deployers.
9. **Incremental mode** (dev) ✅ (M8): instead of a dependency graph, results are memoized by keys that hash *every* input, so a cache can only save work, never serve stale output (`BuildCache`, `CheckCache`): prepared sources and parse results by source text plus the language, image setting, page-URL map and output set (a new or removed page re-parses everything); finished HTML by the page's render item plus the shared context and every template file; copied files hard-linked from the previous build when source, size and mtime match; source-rule findings by source text, page and page-URL map; html-validate findings by page and HTML; output-rule (link) findings by page HTML plus a hash of the site's file list and every page's ids. Pages whose trees the build changes later (documents, pages with images to optimize) are never cached. `build.time` is fixed to the server's start time so unchanged pages stay identical. Memos keep only the entries the last build used.

**Headless-testability conventions** (baked into the default theme and enforced by the checker): a unique `id` on `main`, landmarks, stable `data-testid` hooks on theme components (nav, search, pagination, theme toggle), a logical heading tree, labelled form controls, and no content that only exists after JS (search is progressive enhancement).

## 5. Default theme (`themes/default`)
- Layouts: `base`, `page`, `post`, `list`, `tag`, `tags`, `search`, `404`; partials `header` (with a Search link), `nav`, `footer`, `breadcrumbs`, `pagination`, `page-list`, `tag-links` (M4).
- CSS: custom properties for tokens, `prefers-color-scheme` + `prefers-reduced-motion`, visible `:focus-visible`, AA contrast verified by the checker, responsive layout.
- JS: `assets/js/search.js` (M4), loaded only by the `search` layout: queries Pagefind, announces the result count in a `role="status"` line, keeps the query in `?q=` so results can be linked. No mobile nav toggle: the nav wraps and needs no JS.
- Theme contract documented in `docs/content/themes.md` (required blocks, available context, `theme.json` manifest: name, version, layouts, default layout).

## 6. Checker (`packages/checker`) — `sforge check [--fix [--dry-run]] [--headless|--no-headless] [--pages <globs…>] [--format pretty|json|sarif|junit] [--output <file>] [--fail-on] [--drafts]` ✅ (M3)
User documentation: `docs/content/checker.md`.

`sforge check` builds into a temporary directory (never `build.outDir`), checks the result and removes it. `checkBuild()` checks an existing `BuildResult`; `sforge dev` runs it without the browser after every rebuild and feeds the overlay. Findings come from four **layers**, and each problem is reported once, by the most precise layer (source > build > output > rendered): for page-level rules (`html-lang`, `document-title`, `heading-order`, `img-alt`, `iframe-title`, `meta-viewport`, `video-captions`) by rule and page; for link rules by rule, page and resolved target.

1. **build**: the build's own diagnostics (front-matter, `img-alt`, `video-captions`, `link-broken` for page sources, `heading-shift`, …), with source positions.
2. **source**: rules that re-parse the author's file (Markdown via remark, HTML via `hast-util-from-html` with `verbose` attribute positions; raw HTML inside Markdown is parsed per node) so they have exact positions and can carry **text edits**. Front-matter is blanked line for line, so body positions map back to the file (plus a stripped BOM on line 1).
3. **output**: custom rules on the built HTML (`html-lang`, `document-title`, `meta-viewport`, `landmark-main`, `skip-link`, `video-captions`, `iframe-title`, `link-broken`/`link-fragment`/`link-trailing-slash` resolved with the same `resolveRequest` as the servers) and html-validate (`html/<rule>`; a11y rules carry WCAG criteria; style-only rules downgraded to warnings; `require-sri` only for cross-origin; messages a staticforge rule covers are dropped or aliased, e.g. `heading-level` → `heading-order`, `wcag/h37` → `img-alt`). Findings name the page's source (`file`), its `url` and a CSS `selector`, but no line: rendered pages don't map back to template or content lines.
4. **rendered** (`--headless`; default `check.headless: true`): `playwright-core` launches Chromium (headless shell) against `@staticforge/server` on a free port; every page is loaded in three contexts (desktop light, desktop dark, mobile 375×812), axe-core runs with the tags for `check.wcag` (`2.2-AA` → `wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa`), and results are merged across modes ("(dark only)"). Impact critical/serious → error, otherwise warning. axe rules that match a staticforge rule are aliased (`image-alt` → `img-alt`, `html-has-lang` → `html-lang`, …), the rest are `axe/<id>`. Uncaught page errors → `script-error`. 4 pages in parallel.
   - **Chromium**: not downloaded at install. When missing, the hint names `npx playwright-core@<bundled version> install --only-shell chromium`; `SFORGE_CHROMIUM_PATH` selects another binary. Missing browser → `headless-skipped` warning, except with an explicit `--headless` or `CI` set → `SF_BROWSER_MISSING` (exit 2), so CI never silently skips.

**Autofix** (`--fix`; `--dry-run` returns a unified diff and changes nothing): fixes are text edits to **sources** only, applied from the end of each file, skipping overlaps; then the site is checked again. Implemented in M3:
- `html-lang`: add `lang="<site.language>"` (or fill an empty one) on `<html>` of HTML documents;
- `document-title`: add a `<title>` from the `<h1>` (else the file name) after leading `<meta>` elements, or fill an empty one;
- `heading-order`: change the `#` count of Markdown ATX headings that skip a level, mirroring the build's title/demotion logic (`##`, `####`, `#####` → `##`, `###`, `####`);
- `link-trailing-slash`: rewrite links that redirect (`/about` → `/about/`, or the reverse for `trailingSlash: never`) in Markdown links/definitions and `href`s.

**Never invents alt text.** Not implemented, with reasons: `rel="noopener"` (browsers imply it for `target=_blank`; the build already adds the new-tab notice to content links); id de-duplication (renaming ids breaks `#fragment` links elsewhere); image width/height (the M4 build adds them to every image it optimizes); landmark `aria-label`s and decorative `alt=""` (need author intent). Theme templates are never edited.

**Reporters**: `pretty` (grouped by file; a problem at the same selector on several pages is listed once, as likely theme-caused), `json` (the `CheckResult`, also the `--json` envelope's `data`; schema: `sforge schema diagnostics`, `$id urn:staticforge:schema:diagnostics:v1`), `sarif` 2.1.0 (URIs relative to the git root; problems without a source fall back to the config file; stable `partialFingerprints`), `junit` (failures = at or above `failOn`). `--output` writes the report to a file; `--json` with sarif/junit requires `--output`.

**Diagnostic shape** (shared with the build): `{ ruleId, severity, message, file?, line?, column?, url?, selector?, wcag?, fixable?, hint?, helpUrl? }`. Config: `check: { wcag, failOn, ignore (rule IDs, trailing * for prefixes such as "axe/*"), headless }`.
Exit codes: `0` clean, `1` problems at or above `failOn`, `2` usage/config error or missing browser where required, `3` internal error.

## 7. Dev server — `sforge dev [--port 4321] [--open] [--host [addr]] [--drafts]` ✅ (M2)
- Each build goes into a fresh directory under the OS temp dir (never `build.outDir`); the server switches to it atomically and deletes the previous one after a grace period. A failed build (e.g. invalid config) keeps serving the last good one.
- (M8) The server keeps a worker pool and the build and check caches (§4 step 9) for its lifetime, and writes the Pagefind index after it starts serving each build (`deferSearch`); the checker treats `/pagefind/…` as present when search is enabled.
- **URL semantics match production** via one pure function, `resolveRequest` (`packages/server/src/resolve.ts`; moved to `@staticforge/server` in M3 so the checker can share it): `/x/` → `x/index.html`; `/x` → 301 `/x/` (or `x.html` with `trailingSlash: never`); unknown → `404.html` with status 404; dot-paths (`.sforge/`) and symlinks escaping the root are never served. The M5 CloudFront function must pass the same table of tests. Byte ranges are supported for video.
- chokidar watches the project (ignoring `build.outDir`, dot-dirs, `node_modules`); changes are debounced (≥ 60ms, longer than chokidar's 50ms per-file throttle, so a quick second save is never lost); config changes reload the config.
- Live reload over SSE (`/__sforge/events`): the client (`packages/dev-server/client/live-client.js`) reloads, or hot-swaps stylesheets when only CSS changed, and shows an accessible overlay of the current page's errors/warnings: build diagnostics plus the checker's static rules (run after every build).
- `sforge preview [--port 4322] [--dir]` serves an existing build with the same semantics, without the client.
- Both listen on 127.0.0.1 by default; `--host` without a value binds 0.0.0.0 with a warning. Under `--json` they write the envelope when ready, then run until SIGINT/SIGTERM (exit 0).

## 8a. IaC layer (`providers/iac`) ✅ (M5)
- **Split of responsibilities**: OpenTofu/Terraform owns *infrastructure* (buckets, distribution, functions, certs, DNS, SWA resource, CI identities). The TypeScript SDK deployers own *runtime operations* (content upload, KeyValueStore version switch, rollback, PR previews), because those change on every deploy and would churn state.
- **Engine resolution**: `iac.engine: 'tofu' | 'terraform'` (default `tofu`). Use the binary from PATH if its version is within the supported range. Otherwise download the pinned OpenTofu release and verify its checksum. `iac.version` overrides the pin.
- **Workspace generation**: for each target, sforge writes `.sforge/iac/<target>/` before every run: `main.tf.json` (required providers, provider blocks, a `module` block sourcing the packaged module by relative path, or a vendored copy in `modules/` with `iac.vendor: true`, every input passed from a root variable, re-exported outputs), `backend.tf.json`, `terraform.tfvars.json` (from the validated config) and a `.gitignore`. The first `init` runs `providers lock` for linux/darwin/windows, so the committed `.terraform.lock.hcl` works in CI. Users can also run `tofu` in that directory directly. Profiles (`IacProfile.prepare`) supply the spec per provider; the generic layer knows no cloud.
- **Remote state, in each target's own cloud**:
  - `sforge provision <target> --bootstrap-state` applies a small `state-bootstrap` module with *local* state in `.sforge/iac/_state/<backend id>/`. It then migrates (`init -migrate-state -force-copy`) into the backend it created (key `_sforge/state-bootstrap.tfstate`). An existing backend is never touched (the bucket is shared by all sites of an account and region); a bootstrap whose migration failed resumes on the next run.
  - **AWS**: S3 bucket `sforge-state-<accountId>-<region>` (overridable: `targets.<n>.state.bucket/region/kmsKeyArn`) with BPA on, versioning, SSE (KMS optional), TLS-only policy, `prevent_destroy` and **S3 native locking** (`use_lockfile = true`, no DynamoDB table). Key `<project>/<target>.tfstate`, where `<project>` is `iac.name` or a slug of the `site.baseUrl` host. Existence is checked with `HeadBucket`; a 403 (someone else's bucket) is an `SF_CLOUD_AUTH` error with a hint.
  - **Azure** (M6, with the Azure profile): resource group, plus a Storage Account with no public blob access, TLS 1.2, versioning and soft delete, plus container `tfstate`. Blob lease locking; Entra (`use_azuread_auth`) authentication instead of access keys. The config schema (`targets.<n>.state.resourceGroup/storageAccount/container`) is in place.
  - `--local-state` opts out (experiments only; refused when `CI=true` unless `--force-local-state`).
  - The OIDC CI roles get read/write on their own state key (and its `.tflock`) only, so CI can read outputs and plan; applying infrastructure changes needs broader credentials.
- **Commands map**: `provision --diff` → `init` + `plan -detailed-exitcode` (rendered as a summary and as JSON with `--json`); `provision` → `plan -out` + `apply <plan>` (asks for confirmation unless `--yes`; non-interactive runs without `--yes` fail with `SF_CONFIRMATION_REQUIRED`); `destroy` → applies `preDestroyInputs` (AWS: `force_destroy`) then `plan -destroy` + apply (needs `--confirm <target>`). After apply, `output -json` is cached to `.sforge/state/<target>.json` (non-sensitive outputs only) for the deployers; without the cache (CI) the deployers read outputs from the remote state (`targetOutputs`, profile `purpose: 'outputs'` skips lookups that only affect inputs).
- **Pre-phase**: a profile can name resources applied first with `-target` (AWS: the ACM certificate when DNS is not in Route 53). Their outputs are turned into instructions (the validation CNAMEs), then the full apply waits for validation; `--no-wait` stops after printing them.
- **Drift**: `sforge status <target>` runs `plan -refresh-only`, reports drift and the active version, and exits 1 on drift.
- **Errors**: engine diagnostics are parsed from `-json` (or from text for `init`/`output`) into `details.diagnostics`; credential failures become `SF_CLOUD_AUTH`, everything else `SF_IAC_FAILED`. A changed backend configuration gets a hint to `sforge iac init <target> -- -migrate-state`.
- **Escape hatch**: `.tf`/`.tf.json` files in `infra/<target>/` are copied into the workspace as `infra_*` (a separate `iac.extraModules` option was dropped), so users can add e.g. WAF or logging tweaks without forking. `sforge iac path|init|plan|apply|output|validate|state|show|import|console <target> [-- args]` runs the engine directly (output on stderr under `--json`).

## 8. Provider abstraction (`providers/provider-api`) ✅ (M5)
Provisioning, status drift and destroy are generic (the IaC layer with the provider's `IacProfile`); a provider adds a deployer for runtime operations:
```ts
interface Provider {
  id: 'aws' | 'azure';
  iac: IacProfile;                                   // prepare(target) → workspace spec, state backend, pre-phase
  createDeployer(context: DeployerContext): Deployer; // context carries the target's infrastructure outputs
  requiredOutputs: string[];
}
interface Deployer {
  deploy({ buildDir, preview?, invalidate?, dryRun? }): Promise<DeployResult>; // {versionId, url, uploaded, copied, skipped, deleted, pruned, …}
  versions(): Promise<DeployedVersion[]>;
  rollback(to?): Promise<RollbackResult>;
  destroyPreview(id): Promise<PreviewDestroyResult>;
  current(): Promise<{ url, versionId }>;
}
```
Shared behavior: manifest diffing (`upload` / server-side `copy` / `unchanged`; dot-paths such as `.sforge/` never published), cache-header classes (hashed assets → `public, max-age=31536000, immutable`; everything else → `public, max-age=0, must-revalidate`), content-type mapping (shared with `@staticforge/server`), security headers from `security`, version ids `<UTC>-<git sha>`, preview ids as DNS labels, concurrency-limited uploads (16; the SDK retries), and `--dry-run`.

## 9. AWS provider (`providers/aws`) ✅ (M5)
**Provisioning** (`sforge provision staging`): HCL module `aws/terraform/modules/site` (provider `hashicorp/aws` ≥ 5.x, plus an aliased `aws.us_east_1` provider for ACM), applied via the IaC layer (§8a). Resources:
- **S3 bucket**: Block Public Access (all four), `BucketOwnerEnforced`, SSE-S3 (or SSE-KMS option), versioning on, `enforceSSL`, lifecycle rule to expire noncurrent versions and old deploy prefixes beyond `retainVersions`. **No website hosting endpoint.**
- **CloudFront distribution** with **Origin Access Control** (SigV4) and a bucket policy that allows only `cloudfront.amazonaws.com` with `aws:SourceArn` = this distribution (`GetObject`, plus `ListBucket` so missing objects are 404, not 403). HTTP→HTTPS redirect, HTTP/2+3, TLS 1.2_2021 with a custom domain (the default certificate forces `TLSv1`), compression, one cache policy that honours the objects' `Cache-Control` (no cookies, headers or query strings in the key), a **Response Headers Policy** (HSTS, CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy from `security`), a second policy with `'wasm-unsafe-eval'` on the search page's path patterns, and custom error responses 403/404 → `/_sforge/errors/404.html` (error-page fetches bypass the router, so the deployer copies the active version's `404.html` there on every deploy and rollback).
- **CloudFront KeyValueStore + CloudFront Function (viewer-request)** (`modules/site/router.js`, config substituted at provision time):
  - Maps URLs by rule like `resolveRequest`: `/about/` → `about/index.html` (OAC with the S3 REST origin does not resolve directory indexes), `/about` → 301 `/about/` (or `about.html` with `trailingSlash: never`), dot-segments and malformed paths → 404. A function cannot check S3 for existence, so files that break the rule (section indexes with `never`, extensionless files, `/index`) are stored by the deployer as **route exceptions** `r:<version>:<canonical path>` → `f:<file>` / `r:<location>` / `404` in the KVS. A test runs `router.js` against simulated S3 for every URL of two sample sites and both modes and compares with `resolveRequest` (they differ only in that a nonexistent URL may get a redirect before its 404).
  - Prefixes the URI with the **active version** read from KVS (`/v/<versionId>/...`). Deploys and rollbacks become an **atomic KVS key update** that propagates in seconds, with no distribution update. The rewritten URI is the cache key, so a new version never hits stale cache and no invalidation is needed.
  - For PR previews, maps `Host: <id>.<previewDomain>` → KVS key `host:<id>`. Before the first deploy (`active` = `none`) it answers 503; an unknown preview host gets 404.
  - Terraform resources: `aws_cloudfront_key_value_store`, `aws_cloudfront_function` (`cloudfront-js-2.0`, with `key_value_store_associations`). The initial `active` key is seeded with `aws_cloudfrontkeyvaluestore_key` using `lifecycle { ignore_changes = [value] }`, so later deploys (SDK `PutKey`) never cause drift.
- **Optional custom domain**: ACM certificate in **us-east-1** (aliased provider, SAN `*.<previewDomain>` for previews), DNS validation (`aws_acm_certificate_validation`, 2h timeout; records keyed by the configured names so plans never depend on unknown values). When `hostedZone` is set, Route 53 validation and alias A/AAAA records are added (plus `*.<previewDomain>`). Otherwise the certificate is created in a pre-phase, the required CNAMEs are printed and the full apply waits for validation (`--no-wait` stops after printing). `previewDomain` without `domain` is a config error.
- Optional access logs bucket (`logging: true`; legacy standard logs, so that bucket keeps ACLs with the `awslogsdelivery` grant; 90-day expiry) and optional WAF web ACL ARN attachment.
- **GitHub OIDC deploy role** (target key `ci: { repo: 'org/repo', branches: ['main'], environments: [], pullRequests: true }`, shared by both providers): the account's IAM OIDC provider is reused if one exists, unless it is tagged `sforge:owner = <project>-<target>` (created by this target, so kept under management); otherwise it is created and tagged. A least-privilege role: S3 Get/Put/Delete/List on the bucket, `cloudfront-keyvaluestore:` Describe/Get/List/Put/Delete/UpdateKeys on the store, `cloudfront:CreateInvalidation/GetInvalidation/GetDistribution` on the distribution, and read/write on its own state key and lock file. The trust policy requires `aud = sts.amazonaws.com` and `sub` in `repo:o/r:ref:refs/heads/<branch>`, `repo:o/r:environment:<env>` and (with `pullRequests`) `repo:o/r:pull_request`.
- Module outputs (bucket, region, distribution id/ARN/domain, KVS ARN, URL, preview domain, trailing slash, certificate, validation and DNS records, CI role, OIDC provider) are cached in `.sforge/state/<target>.json` (non-secret).
- Bucket objects under `v/` are **not** managed by Terraform. The lifecycle rule and the deployer manage them, and `force_destroy` is only set during `sforge destroy`.

**Deploy** (`sforge deploy staging`; builds into `build.outDir` and runs the checker first unless `--no-build`/`--no-check`, refusing with `SF_CHECK_FAILED` at or above `check.failOn`):
1. `versionId = <utc-timestamp>-<gitShortSha>` (`GITHUB_SHA` in Actions), e.g. `20261024T173405Z-6ffcbe4`.
2. Upload `dist/` to `s3://bucket/v/<versionId>/` with content type, cache class and `ChecksumSHA256` from the manifest. *Every* file identical to the previous version (same hash and cache class, per `_sforge/manifests/<id>.json`) is copied server-side with `CopyObject` instead of re-uploaded.
3. Write the version's manifest and its route exceptions (KVS `UpdateKeys`, batches of 50 with `IfMatch`).
4. Smoke check: S3 `HEAD` of `v/<versionId>/index.html`. (A CloudFront canary through a preview host is not done.)
5. Copy the version's `404.html` to `_sforge/errors/404.html`, then set `active=<versionId>` in the KVS → live.
6. Record the version in `s3://bucket/_sforge/versions.json`, written with `If-Match`/`If-None-Match` so a concurrent deploy fails (`SF_DEPLOY_FAILED`) instead of losing history. Prune production versions beyond `retainVersions` (objects, manifest and route keys); the S3 lifecycle rule only expires noncurrent object versions and incomplete uploads.
7. Invalidation is unnecessary, because the cache key is the rewritten, versioned URI. `--invalidate` issues a `/*` invalidation anyway.

**Rollback**: `sforge rollback staging [--to <versionId>] [--yes]` republishes that version's 404 page and sets the KVS key back. `sforge versions staging` lists versions (newest first, active marked) and previews.
**Previews**: `sforge deploy staging --preview pr-42` builds with `baseUrl` `https://pr-42.<previewDomain>`, uploads to `v/pr-42/` in place (unchanged files skipped, removed files deleted, stale route keys removed) and sets KVS `host:pr-42 = pr-42`. This needs `domain` + `previewDomain`; without them AWS previews are not available and the command fails with `SF_UNSUPPORTED` and an explanation. `sforge preview-destroy staging pr-42`. Previews share production's 404 page.

## 10. Azure provider (`providers/azure`) ✅ (M6)
**State bootstrap** (`terraform/state-bootstrap`, `hashicorp/azurerm` 4.x + `hashicorp/time`): resource group `sforge-state`, a Storage Account `sfstate<sha256(subscription)[:12]>` (TLS 1.2, no public blobs, **shared keys disabled**, versioning, 30-day soft delete, `prevent_destroy`), private container `tfstate`, and `Storage Blob Data Contributor` for the caller (Owner has no blob data access) plus `data_contributors`, followed by a `time_sleep` (120 s) because RBAC propagation is slow and the bootstrap's own state is migrated into the account right after. The backend is `azurerm` with `use_azuread_auth`; locking is by blob lease. The profile checks the account and container through ARM (`@azure/arm-storage`), and the provider block sets `resource_provider_registrations = "none"` with `resource_providers_to_register = [Microsoft.Web, Microsoft.Storage]` instead of the default set of dozens.
**Provisioning** (`terraform/modules/site`): `azurerm_resource_group` (created, or an existing one with `createResourceGroup: false`) and `azurerm_static_web_app` (Free/Standard, no repo linkage, `preview_environments_enabled`); the deployment token is **not** an output. Location is validated against the five SWA regions. `domain`, `dnsZone` and `ci` are rejected with `SF_UNSUPPORTED` until M9 (`azurerm_static_web_app_custom_domain`, optional DNS records and the `ci-oidc` module with `azuread_application` + federated credentials + role assignments for the SWA and the state container).
**Generated `staticwebapp.config.json`** (`swa-config.ts`): `globalHeaders` from `security` (HSTS, CSP, nosniff, frame options, referrer, permissions, default `Cache-Control: public, max-age=0, must-revalidate`), `trailingSlash` from `build.trailingSlash` (SWA does the redirects natively; `always` maps to SWA's `auto` because SWA's `always` redirects files such as `style.css` to `style.css/`, found live; omitted without `cleanUrls`), `responseOverrides` 404 → `/404.html` with status 404, the search CSP as route headers (`/search`, `/search/`, `/search/*`, `/pagefind…`), immutable cache routes (the shallowest directory holding only fingerprinted files becomes one `/dir/*` rule, others per file, cut off to stay under the platform's 20 KB limit with a warning), and `mimeTypes` for `.avif/.webp/.vtt/…`. A `static/staticwebapp.config.json` of the project wins.
**Deploy**: the deployer never uploads `dist/` directly (it contains `.sforge/`, the build manifest): publishable files plus the generated config are copied to a temporary directory, the deployment token is read with `listStaticSiteSecrets` (never logged or stored) and passed in `SWA_CLI_DEPLOYMENT_TOKEN`, and `swa deploy <dir> --env production|<preview id> --no-use-keychain` runs from an empty working directory (the CLI otherwise reads `.github/workflows`). The deployer then polls ARM (`listStaticSiteBuilds`) until the environment is `Ready` after the upload started. Limits are checked first (15,000 files; 250 MB on Free).
**History**: SWA has no versions, so each production deploy is recorded (newest first, `retainVersions`) in `_sforge/<project>/<target>/versions.json` in the state container, written with `If-Match`/`If-None-Match` and retried on conflict. Previews are listed from ARM.
**Previews**: `--preview pr-42` → SWA named environment `pr-42` (Free: 3, Standard: 10). The deployer's optional `previewBaseUrl(id)` (new in `Deployer`; AWS implements it too) gives the URL the CLI builds with: `<app>-<id>.<region>.<rest of default host>`. `preview-destroy` deletes the environment (`deleteStaticSiteBuild`).
**Rollback by rebuild**: `rollback [--to <versionId|gitSha>]` (default: the entry after the active one) checks the version's commit out into a temporary `git worktree`, shares `node_modules` and the image cache, loads that commit's config through the CLI's loader (`DeployerContext.loadConfig`), builds, and deploys it as a new version with `rollbackOf`. Versions deployed outside git or with uncommitted changes (`dirty`) cannot be rolled back to (`SF_UNSUPPORTED`). Slower than AWS by design. Keeping `dist` archives remains an alternative if rebuilding proves too fragile.

## 11. CLI surface (`packages/cli`)
```
sforge init [dir] [--theme default] [--provider aws|azure] [--yes]   # scaffold project
sforge new page|post <path> [--title]                                 # create content with front-matter
sforge build [--drafts] [--out dist] [--base-url] [--json]
sforge dev [--port] [--open] [--host [addr]] [--drafts]
sforge preview [--port] [--open] [--host [addr]] [--dir]               # serve dist/
sforge check [--fix] [--dry-run] [--headless|--no-headless] [--pages glob] [--format pretty|json|sarif|junit]
sforge provision <target> [--diff] [--bootstrap-state] [--local-state [--force-local-state]] [--no-wait] [--yes]
sforge iac path|init|plan|apply|output|validate|state|show|import|console <target> [-- args]  # low-level access to the generated workspace
sforge deploy <target> [--preview <id>] [--no-build] [--no-check] [--headless|--no-headless] [--invalidate] [--dry-run]
sforge versions <target>
sforge rollback <target> [--to <versionId|gitSha>] [--yes]
sforge preview-destroy <target> <id>
sforge status <target>                                                 # URL, active version, drift (exit 1 on drift)
sforge destroy <target> --confirm <target-name>
sforge ci init [--targets staging,prod]                              # emit GitHub Actions workflows
sforge theme list|validate <path>
sforge schema config|output|diagnostics                              # print JSON Schemas for agents (output: the envelope + every command's data)
sforge config validate|show                                          # validate / print resolved config
sforge version
sforge mcp [--allow-infra]                                            # MCP stdio server
```
Global flags: `--json` (one JSON document on stdout, logs on stderr), `--quiet`, `--verbose`, `--cwd`, `--config`, `--no-color`, `--non-interactive` (auto when `CI=true` or no TTY. Destructive operations then require `--yes`/`--confirm`). `deploy` runs `build` + `check` first by default and refuses if the check fails (`--no-check` to override).

## 12. MCP server (`sforge mcp`) ✅ (M7)
User documentation: `docs/content/mcp.md`.

- **One code path**: every tool runs the CLI command in process (`run()` with a captured `Io`, `--json`, never interactive) and receives its envelope through `Runtime.onResult`, which `action()` calls in every mode (with the human `text` and, for long-running commands, a `live()` getter of the current data). Tools therefore return exactly the `--json` data, error codes and hints of the CLI, and global options of `sforge mcp` (`--cwd`, `--config`, `--quiet`, `--verbose`) apply to every call. Arguments are passed as `--name=value` and positionals after `--`, so no value is ever read as an option.
- **Tools**: `sforge_build`, `sforge_check` (fix, headless, pages, failOn, drafts), `sforge_fix_preview` (`check --fix --dry-run`, the diff as text), `sforge_dev_start` (port 0 by default; returns the latest rebuild while running) / `sforge_dev_stop`, `sforge_new_page` (page or post), `sforge_config` (`config show`), `sforge_schema` (config, diagnostics or output; replaces the planned `sforge_config_schema`), `sforge_deploy`, `sforge_status`, `sforge_versions`, `sforge_rollback`, `sforge_preview_destroy`; with `--allow-infra` also `sforge_provision` and `sforge_destroy`. Annotations mark read-only, local-write and cloud-changing tools.
- **Confirmation**: tools that change a live site (deploy unless `dryRun`, rollback, preview removal, provision unless `diff`) return `SF_CONFIRMATION_REQUIRED` without `confirm: true`; destroy needs the target name as `confirm`, like `--confirm`. The server never prompts; elicitation was not used because client support varies.
- **Results**: `structuredContent` is the command's data, declared as the tool's `outputSchema` (the per-command schemas of `sforge schema output`, wrapped as a Standard Schema that the SDK does not re-validate; the tests validate real output with the MCP client and ajv). `content` is a one-line summary (the diff for fix previews) plus the data as JSON text. Failures are `isError` with `<code>: <message>`, the hint, and the error JSON. A check that finds problems is not an error (`data.ok: false`).
- **Resources**: `sforge://config`, `sforge://diagnostics/latest` (the running dev server's latest build, else the session's latest build/check), `sforge://build-manifest`, `sforge://schema/{config,diagnostics,output}`.
- **Logs and progress**: command logs go to stderr (MCP logging is deprecated in the 2026 spec) and, while the request is open and has a progress token, as progress notifications. `console.log` is redirected to stderr so no library can corrupt the protocol on stdout; engine and SWA child processes already pipe their output.
- **Lifecycle**: session state (dev server, latest diagnostics) lives outside the `McpServer`, because `serveStdio` may create two instances per connection. The server exits when stdin closes or on SIGINT/SIGTERM, stopping its dev server.

## 13. GitHub Actions (`sforge ci init`)
Generates `.github/workflows/`:
- **`site.yml`**: on `pull_request` → install, `sforge build`, `sforge check --headless --format sarif` (uploaded to code scanning, plus PR annotations), `sforge deploy <target> --preview pr-${{ github.event.number }}`, then a comment with the preview URL. On `push` to `main` → build, check, `deploy staging`. A `workflow_dispatch`/release with a `prod` **environment** (protection rules) → `deploy prod`.
- **`preview-cleanup.yml`**: on `pull_request: closed` → `sforge preview-destroy`.
- Auth: `aws-actions/configure-aws-credentials` with `role-to-assume` (from provision output) and `permissions: id-token: write`. `azure/login` with federated client-id/tenant/subscription. Pinned action SHAs, Playwright browser caching, pnpm/npm cache.

## 14. Security and quality
- No secrets in config or state files. Credentials come from standard SDK chains (AWS profile/SSO/OIDC; `DefaultAzureCredential`).
- The CSP (`security.contentSecurityPolicy`) defaults to `default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'` (Shiki's inline styles) plus https images/media/frames, `object-src 'none'`, `frame-ancestors 'self'`; the search page adds `'wasm-unsafe-eval'` (Pagefind). The default theme emits no inline scripts; if it ever does, their hashes must be computed at build time and added to the CSP.
- Path traversal guarded in the dev server and in output writes. Content is sanitized only for user-flagged untrusted HTML (opt-in `rehype-sanitize`), since authors own their content.
- Tests: unit tests per package; golden-output snapshots for `examples/basic-site`; checker rule fixtures (bad/good/fixed HTML trios); AWS deployer against `aws-sdk-client-mock`; HCL modules checked with `tofu validate`, `tflint`, `checkov`, and `tofu test` (mock providers) asserting bucket BPA on, no website config, OAC present, bucket policy SourceArn = distribution, TLS-only, HTTPS redirect; the IaC runner unit-tested with a fake engine binary that emits recorded `-json` streams; Azure deployer with mocked clients; e2e Playwright against `sforge preview`; an optional live integration test (`pnpm test:live`, M8; a CI job comes with M9's OIDC identities) that provisions → deploys → checks over HTTP → rolls back → destroys in a sandbox account/subscription; a browser test of the live-reload client; worker/no-worker and cached/uncached equivalence tests; a tarball install test (`pnpm test:pack`); and a benchmark (`pnpm bench`).

## 15. Milestones
0. **Step 0** ✅: this plan is kept in `PLAN.md` as the project's living design document. Update it when decisions change.
1. **M0 Scaffold** ✅: monorepo, tooling, CI for the repo itself, `core` config + logger + error codes, `cli` skeleton with `--json`/exit codes, `config validate|show`, `schema config|output`, `version`.
2. **M1 Build** ✅: markdown pipeline, HTML detection/wrapping, link resolution, Nunjucks render, default theme (+ `templates/` overrides, `data/`), static/assets copy, build manifest, basic top-level nav, `sforge build`, `init` (non-interactive; `--format ts|json|yaml`), `new page|post`, `examples/basic-site`, docs/content/content.md + docs/content/themes.md.
3. **M2 Preview** ✅: `dev` (watch + SSE live reload + CSS hot-swap + problems overlay) and `preview`, production-equivalent request resolution, per-run isolated test temp dirs.
4. **M3 Checker** ✅: `@staticforge/checker` (source/output/rendered layers with de-duplication, html-validate, axe-core via playwright-core in light/dark/mobile), source autofixes with `--dry-run` diffs, pretty/json/sarif/junit reporters, `sforge check`, `schema diagnostics`, checker results in the dev overlay, `@staticforge/server` split out, GFM task-list labels, Node floor raised to 22.22/24.8, Vitest resolving workspace packages to sources (`ssr.resolve.conditions`; tests previously loaded sibling packages' `dist/`), Chromium installed in CI.
5. **M4 Site features + assets** ✅: `@staticforge/assets` (sharp, esbuild, lightningcss, Pagefind), collections with pagination and RSS/Atom feeds, tags, breadcrumbs, sitemap/robots, responsive images with a persistent cache, bundled/minified/fingerprinted CSS and JS, HTML minification, Pagefind search with the theme's own search page (tested in Chromium), manifest cache classes, `images.optimize`/`images.sizes` and front-matter `order`/`sitemap`, the example site's blog collection.
6. **M5a IaC layer** ✅: `@staticforge/iac` (engine resolver and verified OpenTofu download, workspace generator with `infra/<target>/` merging and vendoring, runner with `-json` parsing, plan/drift summaries, state bootstrap with migration, targeted pre-phase, outputs cache), `provision [--diff]`, `status` (drift, exit 1), `destroy`, `iac` passthrough, `@staticforge/provider-api`, the AWS state-bootstrap module, config `iac.name`, `targets.<n>.state`, `security`, new error codes (`SF_ENGINE_MISSING`, `SF_IAC_FAILED`, `SF_STATE_MISSING`, `SF_NOT_PROVISIONED`, `SF_CLOUD_AUTH`, `SF_CONFIRMATION_REQUIRED`, `SF_ABORTED`, `SF_UNSUPPORTED`, `SF_CHECK_FAILED`, `SF_DEPLOY_FAILED`, `SF_VERSION_NOT_FOUND`), tests with a fake engine binary. The Azure state-bootstrap module moved to M6 with the Azure profile.
7. **M5b AWS** ✅: `@staticforge/aws` (`modules/site`: private S3 + OAC + CloudFront + KVS router function with route exceptions + security headers + optional ACM/Route 53/previews + logs + WAF + OIDC role; `tofu test` suites), IaC profile (STS, state bucket check, OIDC provider reuse), SDK deployer (diffed uploads with server-side copies, checksums, conditional versions document, pruning), `deploy` (build + check first), `versions`, `rollback`, PR previews and `preview-destroy`, `docs/content/deploy.md`, a CI job for the HCL modules. Verified live in a sandbox account (eu-north-1): bootstrap + provision (15 resources), no drift after deploys, two deploys (the second uploaded 5 files and copied 58), routes/redirects/404/security headers, search under the CSP in Chromium, direct S3 access refused (403), rollback visible at the edge in ~8 s, destroy of a non-empty bucket. Fixed during that run: `/pagefind/*` gets the search CSP (Pagefind compiles WebAssembly in a Web Worker), a refresh-only apply after every apply absorbs provider-computed attributes, and profiles declare `expectedDrift` (the `active` KVS key). Not yet run live: custom domain/ACM, previews and the CI role, all deferred to M9 (an automated live job for the core cycle remains in M8).
8. **M6 Azure** ✅: Azure state-bootstrap module and IaC profile, HCL module (SWA on its default `*.azurestaticapps.net` host), `staticwebapp.config.json` generation (headers from `provider-api`), SDK deploy, preview envs (native named environments, no custom domain needed), rollback-by-rebuild. Custom domains and the azuread OIDC identity are in M9. **Code complete** (`@staticforge/azure`; HCL modules with `tofu test`/`terraform test`; unit tests with fake Azure clients, uploader and history store; generated workspaces validate with OpenTofu and Terraform; `Deployer.previewBaseUrl`, `DeployerContext.loadConfig`, `createResourceGroup` and `retainVersions` on Azure targets; keytar's build script denied in `pnpm-workspace.yaml`). **Verified live** in a sandbox subscription (eastus2; bootstrap incl. RBAC propagation and state migration, provision, no drift, two deploys, headers/redirects/404 status/cache classes/content types as served by SWA, search under the CSP in Chromium, `.sforge/` not exposed, preview environment with the predicted URL and canonical, `preview-destroy`, rollback by rebuild in ~30 s, destroy). Fixed during that run: SWA rejects two route rules differing by a trailing slash; SWA's `trailingSlash: always` also redirects files (`style.css` → `style.css/`), so `always` maps to `auto`; Azure strips non-alphanumerics from environment names (`pr-1` → `pr1`); West Europe refused new Storage and SWA resources on a new subscription (`RequestDisallowedByAzure`), hence the `state.location` option. Not covered: the Standard plan, and a deploy from CI (M9).
9. **M7 MCP + schemas** ✅: `sforge mcp` (§12) with tools, resources, confirmations and progress, run through the CLI's own commands; JSON Schemas of every command's `--json` data (`packages/cli/src/schemas.ts`), folded into `sforge schema output` as `$defs/<command>-data` with `if`/`then` rules on `command`; the output and diagnostics schemas shipped as files next to the config schema (`packages/cli/schema/`, kept in sync by a test and `pnpm schema:generate`); `docs/content/mcp.md`. Verified over real stdio with the SDK's client against `examples/basic-site` (2025-era `initialize` too), including exit on stdin EOF with a running dev server, and with Claude Code (verification step 7): `sforge_check` (headless checks included), `sforge_build` and `sforge_config` return structured results, `sforge_deploy` without `confirm` refuses, command errors keep their codes and hints. Claude Code passes only `structuredContent` to the model, not the summary line, so the data must stand on its own. (`sforge ci init` and the GitHub Actions workflows moved to M9.)
10. **M8 Hardening** ✅ (released as 0.1.1 through the release workflow; live tests pass on AWS and Azure). Decided with the user: scoped npm packages in lockstep, the user runs the first publish, live tests run locally on demand, the docs site is built and checked in CI and hosted in M9.
    1. **Benchmark** (`pnpm bench`, `scripts/bench.mjs` against `dist`): a synthetic site (default 2,000 Markdown pages with code blocks, links, tags, a collection, images); cold and warm build, static check, and dev rebuilds after a body edit, a title edit, a CSS edit and a new page. CI runs it at 200 pages to catch crashes. Results at 2,000 pages on the development machine (24 threads, Node 26), before → after M8:

       | | before | after |
       |---|---|---|
       | cold build | 8.6 s | 3.1 s |
       | static check | 9.8 s | 2.2 s |
       | dev rebuild after a body edit | 16 s | 0.5 s (build 0.33 s) |
       | dev rebuild after a title edit | 16 s | 0.7 s |
       | dev rebuild after a CSS edit | 16 s | 0.3 s |
       | dev rebuild after adding a page | 16 s | 2.1 s |
       | `sforge version` (startup) | 0.64 s | 0.09 s |

       Profiling found two free wins first: html-validate resolved (and schema-validated) its config for every page, now resolved once (4× faster per page, identical results), and the Nunjucks loader had `noCache: true`, recompiling templates for every page (a renderer lives for one build, so caching is safe).
    2. **Parallel build and check**: parse, render + finish, source rules and html-validate run in the pool for sites of 100+ pages (`mapInPool`, chunks of `size × 4`, results in item order); image optimization, claims, writes and the manifest stay on the main thread. Parse workers return HTML instead of trees for pages the build won't change further (cheaper to clone, safe to cache). `build.workers` (`number | 'auto'`, default `min(cores - 1, 8)`), `--workers` on build/check/dev/deploy, `SFORGE_WORKERS`. Tests show identical manifests, diagnostics and findings with and without workers. Scaling stops around 8 workers on this machine (render is allocation-heavy; a larger young generation did not help).
    3. **Incremental dev rebuilds and checks**: §4 step 9 and §7.
    4. **Live-reload browser test** (`packages/dev-server/test/live-client.test.ts`, Chromium): reload on content changes, stylesheet swap without navigation, the overlay listing problems with a keyboard-operable toggle, and recovery from a broken config.
    5. **Docs site**: `docs/` is a sforge project (`docs/staticforge.config.ts`, pages in `docs/content/`, an index page); CI builds it and runs `check --headless` with `failOn: warning`. Dogfooding found two default-theme accessibility bugs the example site did not show, both fixed: wide tables and unhighlighted code blocks scrolled without keyboard access (now a content transform wraps tables in a focusable `.table-scroll`, with a named region for captioned tables, and gives every `<pre>` `tabindex="0"`; the theme scrolls the wrapper instead of a `display: block` table), and `github-dark` code comments failed contrast (3:1), so the dark code theme is now `github-dark-default`.
    6. **npm**: MIT `LICENSE` (root and each package), metadata (`repository` with `directory`, `homepage`, `bugs`, `keywords`, `author`, `publishConfig.access`), version 0.1.0 in lockstep (`scripts/version.mjs`, also the default theme's `theme.json`), READMEs (a user-facing one for `staticforge`), the `tofu test` files left out of the provider packages, cloud providers, checker, build, dev server and MCP SDK imported on demand (startup 0.64 → 0.09 s; the checker's report schema got a light `@staticforge/checker/report-schema` export), `scripts/publish.mjs` (pnpm packs, npm publishes, scoped packages first, already-published versions skipped; `--provenance` only in CI, so a first publish from a laptop works), `pnpm test:pack` (installs the 14 tarballs into a new npm project and runs `init`, a 124-page build and check with workers, `schema`, and MCP `tools/list`; a CI job), and `.github/workflows/release.yml` (on `v*` tags: version check, build, tests, pack test, publish through npm trusted publishing with provenance; pinned action SHAs; environment `npm`). Steps for the user in `RELEASING.md`. The user published 0.1.0 from their machine (`publish.mjs` now leaves `npm publish` attached to the terminal so npm can ask for 2FA, `--otp=<code>` optional); 0.1.1 was the first release through the workflow, and a fresh `npm i -D staticforge` verified all 14 packages at 0.1.1 with attestations. Found on the way and recorded in `RELEASING.md`: trusted publisher entries created after 3 Sep 2026 only allow `npm stage publish` until "npm publish" is ticked (`403 … OIDC permission denied for this action`), a missing or mistyped entry fails as `404 Not Found - PUT`, the unscoped `staticforge` is not listed under the npm org, and provenance requires a public repository (the repository was made public).
    7. **Live integration tests** (`pnpm test:live`, `packages/cli/test/live.integration.test.ts`, `SFORGE_LIVE=aws|azure` and `SFORGE_LIVE_CONFIRM=<account|subscription id>`): copies the example site into a temporary git repository with a random `iac.name`; provision with state bootstrap, a no-change plan, deploy, HTTP checks (status, security and cache headers, trailing-slash redirect, the 404 page, `.sforge/` hidden, content types, direct S3 access refused), a second deploy (AWS: server-side copies), no drift, two versions, rollback visible within 10 minutes, an Azure preview and its removal, and `destroy` in `afterAll`. **Passed** on 2026-10-25: AWS (sandbox account, eu-north-1; 3 tests, the preview test is Azure-only, ~10 min) and Azure ("Subscription 2", eastus2 with state in northeurope; 4 tests, ~7 min), leaving no resources behind (only the small state files under `sforge-live-*` in the state backends). Fixed during the first runs, all in the test: hooks kept Vitest's 10 s default, so `destroy` in `afterAll` was killed (cleaned up by hand: stale state lock released, `sforge destroy` against the remote state); the project now lives next to the per-run temp root, so it survives a failed destroy for manual cleanup, and is removed after a successful one; the project gets `init`'s `.gitignore` and commits the IaC workspace after provisioning, because Azure refuses to roll back to a version deployed from a dirty checkout.
    8. Docs: README (install, development commands), `docs/content/content.md` (wide tables, large sites), `themes.md` (scrollable content in the accessibility contract, `build.time` under dev), `deploy.md` (live tests), `RELEASING.md`.

11. **M9 Custom domains + GitHub Actions deploys** (in progress; plan approved 2026-10-25, details in §17): Cloudflare-managed DNS records through a new `dns` target option (`@staticforge/cloudflare`), custom domains `aws.sforge.elchanio-76.eu` (previews on `pr-N.preview.aws.sforge.elchanio-76.eu`) and `azure.sforge.elchanio-76.eu`, the Azure `ci-oidc` identity, per-target base URLs, `sforge ci init`, opt-in domain live tests, and the GitHub flow verified in the test repository `elchanio-76/sforge-ci-test` against `0.2.0-rc.1` (dist-tag `next`).

## 16. Verification (end to end)
1. `pnpm -r test` (unit + snapshot + checker fixtures) plus `tofu test` for the HCL modules and `pnpm -r typecheck`.
2. `cd examples/basic-site && sforge build && sforge check --headless --json`: expect zero errors. Introduce known defects (missing alt, skipped heading, no lang) → expect the matching diagnostics; `sforge check --fix` → re-check shows the fixable ones resolved and alt text still reported.
3. `sforge dev`: edit markdown → the browser reloads; Playwright e2e checks the nav, search and skip link via keyboard.
4. AWS sandbox: `sforge provision staging --bootstrap-state` → state is in the S3 backend with a lockfile; `provision --diff` immediately after shows no changes; deploying twice still shows no drift (KVS key ignored). Verify the S3 bucket is **not** publicly reachable (`curl https://<bucket>.s3.amazonaws.com/v/.../index.html` → 403) while CloudFront serves the site; `deploy` twice → `versions` shows 2; `rollback` → content switches in seconds; `/about/` resolves; the 404 page is served; security headers are present.
5. Azure sandbox: `provision prod` → `deploy prod` → URL serves the site with headers from `staticwebapp.config.json`; `--preview pr-1` creates a named environment; `preview-destroy` removes it.
6. (M9) GitHub: open a PR in a test repo → workflow builds, checks (SARIF annotations), deploys the preview and comments the URL; merge → deploys staging; close → preview cleaned up.
7. MCP: run `sforge mcp` with Claude Code (`claude mcp add sforge -- npx sforge mcp`), call `sforge_check` and `sforge_build`, and verify structured results; `sforge_deploy` without `confirm` must refuse.

## 17. M9 plan: custom domains on Cloudflare DNS + GitHub Actions deploys

### Context
M5 and M6 shipped AWS and Azure without custom domains working end to end. The AWS ACM/Route 53/preview code was written but never run live. Azure rejects `domain`, `dnsZone` and `ci` with `SF_UNSUPPORTED` (`packages/providers/azure/src/iac.ts:165`). `sforge ci init` does not exist yet. M9 closes all three gaps using the user's real domain. `elchanio-76.eu` is registered at GoDaddy and its DNS is on Cloudflare.

Decisions (made with the user, 2026-10-25):
- **DNS**: sforge manages the records in Cloudflare itself, through a new `dns: { provider: 'cloudflare', zone }` target option and the `cloudflare/cloudflare` OpenTofu provider. Records are DNS-only (never proxied). No Route 53 or Azure DNS zones are needed.
- **Names**: `aws.sforge.elchanio-76.eu`, with AWS previews on `pr-N.preview.aws.sforge.elchanio-76.eu`. `azure.sforge.elchanio-76.eu`, with Azure previews staying on SWA's own hosts (SWA has no wildcard custom domains).
- **CI verification**: in a separate public test repo, `elchanio-76/sforge-ci-test`, which installs staticforge from npm.
- **Live tests**: an opt-in domain mode (`SFORGE_LIVE_DOMAIN`), using random labels under the two subdomains.
- **Cloudflare MCP**: installed (`cloudflare-api`, `https://mcp.cloudflare.com/mcp`, local scope, code mode on by default). It is a tool for me (pre-flight checks, verification, cleaning up leftovers), not a runtime dependency of sforge.

Target configs the test repo will use:
```ts
targets: {
  aws:   { provider: 'aws', region: 'eu-north-1',
           domain: 'aws.sforge.elchanio-76.eu', previewDomain: 'preview.aws.sforge.elchanio-76.eu',
           dns: { provider: 'cloudflare', zone: 'elchanio-76.eu' },
           ci: { repo: 'elchanio-76/sforge-ci-test', branches: ['main'], pullRequests: true } },
  azure: { provider: 'azure', resourceGroup: 'rg-sforge-ci-test', location: 'eastus2', state: { location: 'northeurope' },
           domain: 'azure.sforge.elchanio-76.eu',
           dns: { provider: 'cloudflare', zone: 'elchanio-76.eu' },
           ci: { repo: 'elchanio-76/sforge-ci-test', environments: ['production'], pullRequests: true } },
}
```

### A. Prerequisites (set up once by the user)

**Cloudflare**
1. Authenticate the MCP: run `/mcp` → `cloudflare-api` → authenticate in the browser. Grant Zone read and DNS read/write on `elchanio-76.eu`. DNS write lets me remove leftover records after failed live runs.
2. Create an API token for sforge: Dashboard → My Profile → API Tokens → template **"Edit zone DNS"**, zone `elchanio-76.eu`, plus **Zone → Zone → Read** so sforge can look the zone up by name. Export it as `CLOUDFLARE_API_TOKEN` in your shell. It goes in no file, and CI never needs it, because CI only deploys and never provisions.
3. **Do not create the subdomain records by hand.** sforge creates and removes them. A pre-existing record with the same name makes the apply fail.

**AWS** (sandbox account, eu-north-1, the same one as M5/M8)
- Nothing new to create. The admin profile you use for live tests provisions the ACM certificate (us-east-1), CloudFront aliases and the GitHub OIDC provider and role. I'll check whether the account already has a GitHub OIDC provider. sforge reuses it if one exists.

**Azure** ("Subscription 2", eastus2, state in northeurope)
- Your account must be able to create Entra app registrations. Users can by default, unless the tenant restricts it. The Owner role on the subscription covers the role definitions and assignments.

**GitHub**
- Create the public repo `elchanio-76/sforge-ci-test` (I can do it with `gh` once you approve). It has to be public because SARIF code scanning is only free on public repos.
- Create environment `production` with you as the required reviewer, limited to branch `main`.
- Set the repo variables that `sforge ci init` prints: the AWS role ARN, and the Azure client, tenant and subscription IDs. They are identifiers, not secrets.
- npm: the release workflow publishes `0.2.0-rc.1` under dist-tag `next` (see F), so the test repo can install M9 before the final release.

### B. DNS provider abstraction + Cloudflare (`@staticforge/cloudflare`, new package 15)
- **Config** (`packages/core/src/config/schema.ts`): `targets.<n>.dns: { provider: 'cloudflare', zone: hostname, zoneId?: string }` on both providers. It is mutually exclusive with AWS `hostedZone`. The never-implemented Azure `dnsZone` option is removed and replaced by `dns`. `dns` without `domain` is a config error. `domain` and `previewDomain` must lie inside `zone`.
- **Multiple modules per workspace** (`packages/providers/iac/src/spec.ts`, `workspace.ts`): `IacSpec.module` stays the primary module. A new `additionalModules: ModuleSpec[]` takes inputs that can reference other modules (`{ ref: 'module.site.validation_records' }` → `"${module.site.validation_records}"`), plus optional `dependsOn`. Vendoring (`iac.vendor`) copies these modules too, and the lock file covers the extra providers.
- **`DnsProvider` interface** (`packages/providers/provider-api`): `prepare(target)` returns required providers, a provider block, a module dir, and env checks. `CLOUDFLARE_API_TOKEN` is required for `provision`, `destroy` and `status`, but not for `purpose: 'outputs'`. Without it the command fails with `SF_CLOUD_AUTH` and a hint. The Cloudflare provider is only added to a workspace whose target has `dns`, so AWS and Azure users without it download nothing extra.
- **Module** `terraform/modules/records`: `cloudflare_dns_record` resources (provider v5) keyed by the record name (so keys are known at plan time), with `proxied = false`, `ttl = 1` (auto), and comment `staticforge <project>/<target>`. The zone is looked up by name unless `zoneId` is given. It outputs the record ids and FQDNs. `tofu test` with a mock provider covers it.
- Each site module is wired to **two instances** of this module: `dns_validation` and `dns_routing`. The split avoids a dependency cycle, because the certificate has to be validated before the distribution can use it, and the routing CNAME needs the distribution's hostname.

### C. AWS (`packages/providers/aws`)
- `modules/site`: new input `validation_record_fqdns` from `module.dns_validation.fqdns`, used by `aws_acm_certificate_validation` so the apply waits for the Cloudflare records. Routing records are CNAMEs: `domain` → distribution domain, and `*.<previewDomain>` → distribution domain.
- `src/iac.ts`: with `dns`, the profile skips the pre-phase (validation records are created in the same apply) and adds the two DNS modules. The existing Route 53 (`hostedZone`) and print-and-wait paths stay as they are.
- Verify live what M5 never ran: ACM validation, the custom domain on TLS 1.2_2021, PR previews on `pr-N.preview.aws.sforge…` (KVS host mapping), and the OIDC role used from GitHub Actions. CI reads outputs from the remote state.

### D. Azure (`packages/providers/azure`)
- **Custom domain** (`modules/site`): `azurerm_static_web_app_custom_domain` with `validation_type = "cname-delegation"`. The provider waits for validation (up to a 30-minute timeout), but the CNAME must already exist. So the resource depends on a `terraform_data` that takes `var.dns_ready` (the `dns_routing` record ids) as its input. Apex domains (which need `dns-txt-token`) are rejected with a clear error for now. The `url` output becomes `https://<domain>/`.
- **Without `dns`**: a pre-phase, the same mechanism AWS uses for printing CNAMEs. It applies the SWA, prints the CNAME `domain → <default host>`, polls DNS until the name resolves, then applies the custom domain. `--no-wait` stops after printing. I'll verify it once by hand, creating the CNAME through the Cloudflare MCP.
- **`ci-oidc`** (`modules/site/ci.tf`, adds `hashicorp/azuread` when `ci` is set):
  - `azuread_application`, service principal, and one federated credential per subject. The subjects match AWS: `repo:o/r:ref:refs/heads/<b>`, `…:environment:<e>`, `…:pull_request`. Issuer is GitHub, audience `api://AzureADTokenExchange`.
  - A custom role definition, assigned on the SWA only, with the actions the deployer calls: staticSites read, listSecrets, builds read and delete. I'll confirm the exact list against the deployer's ARM calls.
  - `Storage Blob Data Contributor` on the state container, with an ABAC condition restricting it to `<project>/<target>.tfstate*` and `_sforge/<project>/<target>/` (version history).
  - Outputs: client id, tenant id, subscription id.
- Remove the `SF_UNSUPPORTED` guard. Error mapping covers SWA quota limits (2 custom domains on Free) and Entra permission failures.

### E. Per-target base URL (`packages/cli/src/commands/deploy.ts`, core config)
Production builds for a target with `domain` use `https://<domain>/` (canonical URLs, sitemap, feeds, OG) instead of `site.baseUrl`. `targets.<n>.baseUrl` overrides it. Previews keep using `previewBaseUrl`. Without this, two targets on two domains would publish wrong canonical URLs.

### F. `sforge ci init` + release plumbing
- **Command**: `sforge ci init [--targets aws,azure] [--production <target>] [--package-manager pnpm|npm] [--force] [--json]`, in `packages/cli/src/commands/ci.ts`, with templates in `packages/cli/src/ci/`. It writes:
  - `.github/workflows/site.yml`:
    - **PR**: build, then `check --headless --format sarif`, upload to code scanning, then preview deploy per target, then one upserted PR comment holding the preview URLs (marker `<!-- sforge-preview -->`, posted with `gh`).
    - **Push to `main`**: deploy the non-production targets.
    - **Production target**: a job with `environment: production` (needs reviewer approval).
    - **`workflow_dispatch`**: rollback (`target`, `to`).
  - `.github/workflows/preview-cleanup.yml`: on `pull_request: closed`, run `preview-destroy` per target.
- **Workflow details**:
  - Minimal `permissions` per job (`id-token: write`, `contents: read`, `pull-requests: write` and `security-events: write` only where needed).
  - Fork PRs are skipped, since they get no OIDC token. `concurrency` is set per target, because concurrent deploys fail on `versions.json`.
  - `fetch-depth: 0` for Azure rollback by rebuild. Caches for Playwright, the package manager and the OpenTofu download.
  - Auth: `aws-actions/configure-aws-credentials` (`vars.SFORGE_<TARGET>_ROLE_ARN`) and `azure/login` (OIDC).
- **Pinned action SHAs** live in one table, `packages/cli/src/ci/actions.ts`. A test checks they are 40-hex with a version comment, and `scripts/ci-pins.mjs` refreshes them with `gh api`.
- **Variables**: `ci init` reads the cached outputs (`.sforge/state/<target>.json`) and prints the `gh variable set …` commands (also in `--json`). `--json` output and MCP schemas are added for the new command, and the MCP gets no new cloud tool.
- **Release**: `scripts/publish.mjs` and `release.yml` publish prerelease versions (`x.y.z-rc.N`) under dist-tag `next`, which npm requires for prereleases.

### G. Live tests (`packages/cli/test/live.integration.test.ts`)
- **Opt-in**: `SFORGE_LIVE_DOMAIN=aws.sforge.elchanio-76.eu` (or the Azure one) plus `SFORGE_LIVE_DNS_ZONE=elchanio-76.eu` and `CLOUDFLARE_API_TOKEN`.
- The target gets `domain: t-<rand>.<parent>`. AWS also gets `previewDomain: p-<rand>.<parent>`.
- Checks:
  - HTTPS on the custom host with a valid certificate (Node's fetch verifies it).
  - Canonical and sitemap URLs on the domain.
  - AWS preview at `pr-1.p-<rand>.<parent>`, then `preview-destroy`.
  - After `destroy`, the Cloudflare records are gone (Cloudflare API, filtered by name).
- Hook timeouts are raised: AWS ~25 min (certificate + distribution), Azure ~35 min (domain validation + managed certificate). Random labels avoid CloudFront alias conflicts and leftover-record collisions.

### H. Docs and plan
- `docs/content/deploy.md`: custom domains (Cloudflare, Route 53, manual CNAMEs), DNS-only requirement, CAA notes, token scope.
- New `docs/content/ci.md`: `sforge ci init`, variables, environments, forks.
- Config reference regenerated (`pnpm schema:generate`).
- `PLAN.md`: replace the M9 entry with this plan, and update §8a/§9/§10/§13 as decisions land.

### Order of work
1. You: Cloudflare MCP OAuth + API token (A).
2. Me, via MCP: pre-flight on `elchanio-76.eu`. Check for existing records under `sforge.`, CAA records (they must allow `amazon.com` and SWA's issuer if any CAA exists), and the DNSSEC/proxy defaults. Fixed before any apply.
3. Code B → C → E → D → F with unit and `tofu test` coverage, then `pnpm -r test`, `pnpm test:iac`, `pnpm -r typecheck`, lint.
4. Live domain tests: AWS, then Azure (G). This creates and destroys sandbox resources, so I'll ask before each run.
5. Release `0.2.0-rc.1` (`next`) through the tag workflow. You push the tag, as in M8.
6. Test repo: `sforge init`, `ci init`, then `provision aws` and `provision azure` locally (admin profile + `CLOUDFLARE_API_TOKEN`), then set variables and run the GitHub flow (verification step 6).
7. Fixes found, then release `0.2.0`, then update PLAN.md and commit.

### Verification
- `pnpm -r test`, `pnpm test:iac` (new `records` module, AWS/Azure modules with `dns` and `ci`, workspaces with additional modules validated by OpenTofu and Terraform), `pnpm test:pack` (15 packages).
- `pnpm test:live` with `SFORGE_LIVE=aws|azure`, with and without `SFORGE_LIVE_DOMAIN`. Both pass and leave no records or resources behind, confirmed through the Cloudflare MCP and the cloud CLIs.
- Test repo (PLAN §16 step 6):
  - **Open a PR**: SARIF annotations, previews on `pr-N.preview.aws.sforge…` and the SWA preview host, one PR comment with both URLs.
  - **Merge**: `aws.sforge…` updates. The `production` job waits for approval, then `azure.sforge…` updates.
  - **Close a PR**: previews are removed.
  - **Rollback dispatch**: works for both targets.
- **Least privilege**: the CI identities cannot provision. A deliberate `sforge provision --diff` in CI fails with `SF_CLOUD_AUTH` beyond reading state.
- Optional, your call: Route 53 `hostedZone` path, by delegating `r53.sforge.elchanio-76.eu` to a hosted zone that is deleted within 12 hours (no charge).

### Not in M9
- Hosting the docs site (M8 deferred it here). I'd suggest `docs.sforge.elchanio-76.eu` as a follow-up once the CI flow is proven.
- Azure apex domains (`dns-txt-token`), Azure DNS zones, and Cloudflare proxying.
