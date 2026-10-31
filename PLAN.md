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

## 13. GitHub Actions (`sforge ci init`) ✅ (M9, code; verified in the test repository in M9)
User documentation: `docs/content/ci.md`. `sforge ci init [--targets a,b] [--package-manager pnpm|npm] [--force]` writes, at the git root (with `defaults.run.working-directory` when the project is in a subdirectory):
- **`sforge.yml`**: on `pull_request` and `push`. Job `check`: install, Chromium (`npx playwright-core@<checker's version> install --with-deps --only-shell chromium`, cached), `sforge check --headless --format sarif`, upload to code scanning (category `sforge`). Per target with previews (`ci.pullRequests`, and on AWS `domain` + `previewDomain`): `preview-<t>` deploys `--preview pr-<n> --no-headless` and outputs the URL; job `comment` upserts one PR comment (marker `<!-- sforge-preview -->`, `gh api`). Per target: `deploy-<t>` on push to the first of `ci.branches` (`main` without any), inside the first of `ci.environments` when set (its protection rules gate the deploy; the OIDC subject is then the environment).
- **`sforge-preview-cleanup.yml`** (only when a target has previews): on `pull_request: closed`, `preview-destroy` per target.
- **`sforge-rollback.yml`**: `workflow_dispatch` with `target` (choice) and optional `to`; Azure jobs check out with `fetch-depth: 0` (rollback by rebuild).
- Every workflow starts with `permissions: {}`; jobs get only `id-token: write` (cloud sign-in), `security-events: write` (upload) or `pull-requests: write` (comment). Fork PRs are checked but never deployed (no OIDC token). Event values reach scripts through `env`, never `${{ }}` inside `run`. Deploys per target share a `concurrency` group (the version history refuses concurrent writes). `~/.cache/staticforge` (OpenTofu and providers) is cached by the lock files' hash.
- Auth: `aws-actions/configure-aws-credentials` with `vars.SFORGE_<T>_ROLE_ARN`; `azure/login` with `vars.SFORGE_<T>_CLIENT_ID/TENANT_ID/SUBSCRIPTION_ID` (and `AZURE_SUBSCRIPTION_ID` for sforge). `ci init` prints `gh variable set` commands from the cached outputs, or says which targets to provision first.
- Actions are pinned to commit SHAs with version comments in `packages/cli/src/ci/actions.ts`; `node scripts/ci-pins.mjs [--dry-run]` refreshes them from each action's newest `vX.Y.Z` tag. The generated files pass `actionlint` with shellcheck.

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

11. **M9 Custom domains + GitHub Actions deploys** ✅ (released as 0.2.0 on 2026-10-25; plan approved the same day, details in §17): Cloudflare-managed DNS records through a new `dns` target option (`@staticforge/cloudflare`), custom domains `aws.sforge.elchanio-76.eu` (previews on `pr-N.preview.aws.sforge.elchanio-76.eu`) and `azure.sforge.elchanio-76.eu`, the Azure `ci-oidc` identity, per-target base URLs, `sforge ci init`, opt-in domain live tests, and the GitHub flow verified in the test repository `elchanio-76/sforge-ci-test` against `0.2.0-rc.2` (dist-tag `next`; immutable OIDC subjects, previews marked noindex and three CI fixes found there). The test repository's resources were destroyed after the user checked both sites.
12. **M10 Private sites** ✅ (released as 0.3.0 on 2026-10-28; planned 2026-10-26, details in §18; live runs and the CI check in `sforge-ci-test` passed 2026-10-28): `targets.<n>.auth` makes a target require sign-in on every URL (AWS: Cognito user pool, session cookie checked by the router function, a regional Lambda for sign-in; Azure Free: preconfigured providers and invited users in the `member` role), `sforge users list|invite|remove|revoke-sessions`, and `privateDns` (validation records public, the site's records printed for internal DNS).
13. **M11 Firebase Hosting** (planned 2026-10-26, details in §19; verified live and from a real repository; `0.4.0` released 2026-10-31): a third provider, `@staticforge/firebase` (package 16), public sites only: Blaze plan within the free quotas in an existing project, GCS state, Hosting REST API deployer with native preview channels and release-based rollback, Workload Identity Federation for CI, custom domains through Cloudflare.
14. **M12 Code review** (done 2026-10-29, released as 0.3.1; details in §20): a full review of the code base in three parts, each with findings recorded in `REVIEW.md` and fixed with tests or deferred with a reason: code quality (per package, with coverage, unused-code and layering tools), security (private-site sign-in, CI identities and workflows, secrets, input handling, the MCP server, the 13 `pnpm audit` advisories that all arrive through `@azure/static-web-apps-cli`), and CLI ↔ MCP parity (an inventory of every command, option and tool, a parity test suite that runs both interfaces on the same fixtures, and documented drift).

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
- **Cloudflare MCP**: installed (`cloudflare-api`, `https://mcp.cloudflare.com/mcp`, local scope, code mode on by default). It is authorized read-only (the consent screen offers only minimal, read-only and full-access presets) and is a tool for me (pre-flight checks, verifying records), not a runtime dependency of sforge. Leftover records from failed runs are removed by `sforge destroy` with sforge's own token, or listed for the user to delete.

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
1. Authenticate the MCP: run `/mcp` → `cloudflare-api` → authenticate in the browser with the **read-only** preset (done 2026-10-25; full access would grant write on the whole account).
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
**Done (2026-10-25).** As built, where it differs from the outline below:
- `DnsProfile` lives in `@staticforge/iac` (`spec.ts`), next to `IacProfile`, not in `provider-api`: it is IaC-level. `ProfileInput.dns` / `IacRunOptions.dns` carry it; the CLI loads `@staticforge/cloudflare` on demand when a target has `dns` (`dnsProfileFor` in `packages/cli/src/cloud.ts`, injectable through `Runtime.dns`). Cloud profiles call `prepareDns(input, names)` (checks: `domain` set, every name inside `zone`) and `withDns(spec, prepared, sets)` (`packages/providers/iac/src/dns.ts`).
- Module inputs may be `iacRef('module.x.y')`, written as expressions. Literal inputs of additional modules go through root variables named `<module>__<input>`; the main module's keep their names. Empty `provider`/`variable` blocks are omitted (an empty object reads as a block without a label). `dependsOn` was not needed.
- The zone is looked up in TypeScript (`GET /zones?name=`, clear `SF_CLOUD_AUTH`/`SF_CONFIG_INVALID` errors) and passed to the module as `zone_id`; the provider block stays empty (the provider reads `CLOUDFLARE_API_TOKEN` itself). Reading outputs needs no token (`zone_id` is then `""`, never evaluated). Comments are cut to 100 characters (Free plan limit).
- The records module takes `map(object({ name, type, value }))` (the shape of the existing AWS outputs) and only accepts CNAMEs for now; trailing dots are trimmed.
- `init` now re-runs `providers lock` for all platforms whenever the lock file lacks a provider that `main.tf.json` requires (a DNS provider added to a provisioned target), not only on the first init.
- Tests: `tofu test` for the records module (CI job), unit tests for the helpers, the zone lookup and the CLI wiring, and `pnpm test:iac` validates a workspace with a stand-in site module and both records modules with OpenTofu (plain and vendored) and Terraform: no dependency cycle. `pnpm test:pack` expects 15 packages. `RELEASING.md` explains the one manual first publish a new package needs.
- AWS and Azure profiles reject `dns` with `SF_UNSUPPORTED` until C and D wire it.

- **Config** (`packages/core/src/config/schema.ts`): `targets.<n>.dns: { provider: 'cloudflare', zone: hostname, zoneId?: string }` on both providers. It is mutually exclusive with AWS `hostedZone`. The never-implemented Azure `dnsZone` option is removed and replaced by `dns`. `dns` without `domain` is a config error. `domain` and `previewDomain` must lie inside `zone`.
- **Multiple modules per workspace** (`packages/providers/iac/src/spec.ts`, `workspace.ts`): `IacSpec.module` stays the primary module. A new `additionalModules: ModuleSpec[]` takes inputs that can reference other modules (`{ ref: 'module.site.validation_records' }` → `"${module.site.validation_records}"`), plus optional `dependsOn`. Vendoring (`iac.vendor`) copies these modules too, and the lock file covers the extra providers.
- **`DnsProvider` interface** (`packages/providers/provider-api`): `prepare(target)` returns required providers, a provider block, a module dir, and env checks. `CLOUDFLARE_API_TOKEN` is required for `provision`, `destroy` and `status`, but not for `purpose: 'outputs'`. Without it the command fails with `SF_CLOUD_AUTH` and a hint. The Cloudflare provider is only added to a workspace whose target has `dns`, so AWS and Azure users without it download nothing extra.
- **Module** `terraform/modules/records`: `cloudflare_dns_record` resources (provider v5) keyed by the record name (so keys are known at plan time), with `proxied = false`, `ttl = 1` (auto), and comment `staticforge <project>/<target>`. The zone is looked up by name unless `zoneId` is given. It outputs the record ids and FQDNs. `tofu test` with a mock provider covers it.
- Each site module is wired to **two instances** of this module: `dns_validation` and `dns_routing`. The split avoids a dependency cycle, because the certificate has to be validated before the distribution can use it, and the routing CNAME needs the distribution's hostname.

### C. AWS (`packages/providers/aws`)
**Done; verified live on 2026-10-25** (`pnpm test:live` with `SFORGE_LIVE_DOMAIN=aws.sforge.elchanio-76.eu`, sandbox account, eu-north-1, run `nnfc51`, 11 minutes): the validation records were created in Cloudflare and ACM validated within 14 s in the same apply; the distribution took about 3 minutes, then the domain and `*.p-<id>` CNAMEs; HTTPS with a valid certificate and canonical URLs on the domain; a preview served on `pr-1.p-<id>.<parent>` and 404 after `preview-destroy`; destroy left no records (checked through the Cloudflare MCP). The CI role was verified in the test repository (F). As built:
- `modules/site` takes `validation_record_fqdns` (used when `hosted_zone` is null) and outputs `dns_validation_records` and `dns_routing_records`, maps keyed by names known when planning. `x` and `*.x` share one ACM validation record, so validation records are keyed by the name without `*.` (with `previewDomain` equal to `domain`, one record serves both; Route 53 hid this through `allow_overwrite`).
- The profile refuses `dns` together with `hostedZone` (`SF_CONFIG_INVALID`), checks `domain` and `previewDomain` against the zone, adds `dns_validation` and `dns_routing` records modules, and skips the print-and-wait pre-phase.
- Tests: two new `tofu test` runs (external DNS; shared validation record), `packages/providers/aws/test/iac.test.ts` (the profile's first unit tests), and the generated workspace with Cloudflare DNS validates with OpenTofu and Terraform. `docs/content/deploy.md` has a "DNS records in Cloudflare" section.

- `modules/site`: new input `validation_record_fqdns` from `module.dns_validation.fqdns`, used by `aws_acm_certificate_validation` so the apply waits for the Cloudflare records. Routing records are CNAMEs: `domain` → distribution domain, and `*.<previewDomain>` → distribution domain.
- `src/iac.ts`: with `dns`, the profile skips the pre-phase (validation records are created in the same apply) and adds the two DNS modules. The existing Route 53 (`hostedZone`) and print-and-wait paths stay as they are.
- Verify live what M5 never ran: ACM validation, the custom domain on TLS 1.2_2021, PR previews on `pr-N.preview.aws.sforge…` (KVS host mapping), and the OIDC role used from GitHub Actions. CI reads outputs from the remote state.

### D. Azure (`packages/providers/azure`)
**Done; custom domain verified live on 2026-10-25** (`pnpm test:live` with `SFORGE_LIVE_DOMAIN=azure.sforge.elchanio-76.eu`, "Subscription 2", eastus2, run `b2wppb`, 12 minutes, after the fix below): app 18 s, CNAME 1 s, `waitForCname` until both Cloudflare nameservers answered, then Azure validated the domain and issued its certificate in 3 min 58 s; HTTPS and canonical URLs on the domain, rollback by rebuild, a preview environment, and destroy left no records. The GitHub Actions identity was verified in the test repository (F). As built:
- `modules/site`: `domain` and `dns_ready` inputs; `azurerm_static_web_app_custom_domain` (cname-delegation, 1 h create timeout) depends on a `terraform_data` fed with the `dns_routing` record IDs, so the CNAME exists first. Outputs `domain`, `dns_records` (printed without `dns`), `dns_routing_records` and `resource_group_id`; `url` uses the domain.
- **Found live (run `69brus`, 2026-10-25):** Azure checks the CNAME synchronously when the custom domain is added and refuses it (`BadRequest 51021: CNAME Record is invalid. Please ensure the CNAME record has been created.`) without retrying; the record had been created in Cloudflare one second earlier. The provider's polling only covers validation after Azure accepted the domain. So every Azure custom domain now has a pre-phase: apply the app (and with `dns` the `module.dns_routing` CNAME) with `-target`, print the CNAME when sforge does not manage DNS, then `prePhase.wait` (new in the IaC layer, skipped with `--no-wait`) polls the zone's authoritative nameservers (`waitForCname`, `packages/providers/azure/src/cname.ts`; asking a recursive resolver early would cache NXDOMAIN for the zone's negative TTL) until all answer with the app's host, up to an hour, before the full apply adds the domain. Apex domains are refused (`SF_UNSUPPORTED`): equal to `dns.zone`, or two labels when there is no zone.
- `modules/ci-oidc` is a separate module, added only with `ci`, so other targets never download `hashicorp/azuread` (3.x). Federated login names are `branch-<b>`, `environment-<e>`, `pull-request` (sanitized; Entra allows 20 per application, checked in TypeScript). The custom role is defined on the site's resource group (custom roles cannot be assignable to a single resource) and assigned on the app; its name includes the subscription (role names are unique per tenant). State access is the built-in Storage Blob Data Contributor on the container with an ABAC condition: read (except List Blobs), write, add and delete only for `<project>/<target>.tfstate` and `_sforge/<project>/<target>/`; listing names stays allowed because the backend lists the container.
- The IaC layer gained `IacSpec.additionalOutputs` (root outputs from other modules): `ci_client_id`, `ci_tenant_id`, `ci_subscription_id`.
- To verify live in CI (F): whether the azurerm backend needs any management-plane call with `use_azuread_auth`, and whether `azure/login` finds the subscription when the identity only has resource-scoped roles (fallback: `allow-no-subscriptions` plus `AZURE_SUBSCRIPTION_ID`).
- Tests: `tofu test` for `ci-oidc` (3 runs) and two new site runs, profile unit tests (domain with Cloudflare, printed CNAME, apex refusal, identity inputs, the 20-login limit), and the full Azure workspace (site + Cloudflare + identity) validates with OpenTofu and Terraform. Docs: "Custom domain" and "GitHub Actions identity" under Azure in `deploy.md`.

- **Custom domain** (`modules/site`): `azurerm_static_web_app_custom_domain` with `validation_type = "cname-delegation"`. The provider waits for validation (up to a 30-minute timeout), but the CNAME must already exist. So the resource depends on a `terraform_data` that takes `var.dns_ready` (the `dns_routing` record ids) as its input. Apex domains (which need `dns-txt-token`) are rejected with a clear error for now. The `url` output becomes `https://<domain>/`.
- **Without `dns`**: a pre-phase, the same mechanism AWS uses for printing CNAMEs. It applies the SWA, prints the CNAME `domain → <default host>`, polls DNS until the name resolves, then applies the custom domain. `--no-wait` stops after printing. I'll verify it once by hand, creating the CNAME through the Cloudflare MCP.
- **`ci-oidc`** (`modules/site/ci.tf`, adds `hashicorp/azuread` when `ci` is set):
  - `azuread_application`, service principal, and one federated credential per subject. The subjects match AWS: `repo:o/r:ref:refs/heads/<b>`, `…:environment:<e>`, `…:pull_request`. Issuer is GitHub, audience `api://AzureADTokenExchange`.
  - A custom role definition, assigned on the SWA only, with the actions the deployer calls: staticSites read, listSecrets, builds read and delete. I'll confirm the exact list against the deployer's ARM calls.
  - `Storage Blob Data Contributor` on the state container, with an ABAC condition restricting it to `<project>/<target>.tfstate*` and `_sforge/<project>/<target>/` (version history).
  - Outputs: client id, tenant id, subscription id.
- Remove the `SF_UNSUPPORTED` guard. Error mapping covers SWA quota limits (2 custom domains on Free) and Entra permission failures.

### E. Per-target base URL (`packages/cli/src/commands/deploy.ts`, core config)
**Done (2026-10-25).** `targetBaseUrl(config, target)` in `packages/core/src/config/load.ts` (`targets.<n>.baseUrl`, else `https://<domain>/`, else `site.baseUrl`; unknown targets fall back to `site.baseUrl`) is used by production deploys and by Azure's rollback rebuild (with the old commit's config). `sforge build` keeps `site.baseUrl`, and `projectName` (state keys) still derives from `site.baseUrl`, so state locations do not move. Known, unrelated: two dev-server tests are load-sensitive under the full suite (the search-index poll, and the temp-directory count on close); both predate M9 and are left for a separate fix.

Production builds for a target with `domain` use `https://<domain>/` (canonical URLs, sitemap, feeds, OG) instead of `site.baseUrl`. `targets.<n>.baseUrl` overrides it. Previews keep using `previewBaseUrl`. Without this, two targets on two domains would publish wrong canonical URLs.

### F. `sforge ci init` + release plumbing
**Done; verified in the test repository on 2026-10-25 with `0.2.0-rc.2`.** As built: see §13. Differences from the outline below: the files are named `sforge*.yml` (so they never clobber a repository's own workflows) and rollback is its own workflow; which target deploys through an environment follows from its `ci.environments` instead of a `--production` flag; the cleanup workflow is left out when no target has previews. `scripts/publish.mjs` publishes versions with a prerelease part under the dist-tag `next` (`RELEASING.md`).

**Verification** (`elchanio-76/sforge-ci-test`, public, npm, environment `production` with the user as reviewer and limited to `main`; both targets provisioned locally in 3m39s (AWS, 24 resources) and 6m31s (Azure, 12), then `ci init` printed the four variables, set with `gh variable set`):
- Push to `main`: `aws.sforge.elchanio-76.eu` deployed; the Azure job waited for approval, then `azure.sforge.elchanio-76.eu` deployed (HTTPS, canonical URLs on each target's domain). `azure/login` and the azurerm backend work with roles on the app and the state container only (no subscription-level role).
- PR: SARIF uploaded and annotated (`heading-order` on `content/news.md:8`), previews on `pr-N.preview.aws.sforge.elchanio-76.eu` and the SWA preview host, one upserted comment with both URLs. Merge: deploys, Azure after approval. Close (merge): both previews removed (404).
- Rollback dispatch: AWS switched in seconds at most edges and about two minutes at all of them; Azure rebuilt the older commit after approval.
- Least privilege: `sforge provision --diff` with the AWS CI role fails at the state bucket (`SF_CLOUD_AUTH`; its `s3:ListBucket` is limited to its own key). The Azure CI identity holds only the custom role on the app (`staticSites` read, `builds` read/delete, `listSecrets`) and Blob Data Contributor on the state container with the ABAC condition (checked with `az role assignment list`); its CI run stopped earlier, at the Cloudflare lookup with a dummy token.

**Found and fixed on the way** (released as `0.2.0-rc.2`):
- **Immutable OIDC subjects.** Repositories created since July 2026 present `repo:owner@<id>/repo@<id>:…`, so both clouds refused the first deploys (`AssumeRoleWithWebIdentity` denied, `AADSTS700213`). `provision` now reads the repository's `sub_claim_prefix` from `GET /repos/{repo}/actions/oidc/customization/sub` (no token needed for public repositories; `GH_TOKEN`/`GITHUB_TOKEN` for private ones), or takes `ci.subjectPrefix`; custom subject templates are refused (`SF_UNSUPPORTED`). Reading outputs skips the lookup. Re-provisioning updated the trust policy and the two federated logins in place.
- **Azure preview removal** failed in CI after deleting the environment: the SDK's poller reads `Microsoft.Web/locations/staticSitesOperationStatuses` at subscription scope. The deployer now only sends the delete and waits until the environment leaves the build list.
- **Every CI deploy was recorded as dirty**, so Azure could not roll back to it: the workflow wrote `deploy.json` into the checkout, and sforge rewrites `.sforge/iac/` before reading outputs. `gitIsDirty` now leaves `.sforge/` out and the workflows write to `$RUNNER_TEMP`.
- **Previews were indexable** on AWS (Azure previews get `X-Robots-Tag` from SWA). Preview builds now add `<meta name="robots" content="noindex">` to every page, in the build (`noindex` option of `buildSite`), so any theme gets it.
- **Generated jobs had no `timeout-minutes`**; a Chromium install hung on an apt mirror. Every job now has one (5 to 30 minutes).
- Smaller: `provision` no longer prints "Point your DNS at CloudFront" when Route 53 or a dns provider manages the records (and the text is provider-neutral); a command group without its subcommand reports `Missing subcommand` instead of `(outputHelp)` in `--json`; the state bucket's access-denied hint mentions CI roles.
- Noted, not changed: the project name (resource names, state keys) comes from `site.baseUrl`, so a repository with per-target domains gets `aws-sforge-elchanio-76-eu-azure`-style names unless `iac.name` is set (now said in the deploy docs). npm can take a minute or two to serve every package of a fresh release (`ETARGET` meanwhile). The gh CLI token lacked the `workflow` scope, so the test repository is pushed over SSH.

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
**Done; passed on 2026-10-25 on AWS (4 tests, 11 minutes) and Azure (4 tests, 12 minutes, second run).** As outlined below: `SFORGE_LIVE_DOMAIN` + `SFORGE_LIVE_DNS_ZONE` (both required together, plus `CLOUDFLARE_API_TOKEN`) give the target `t-<id>.<parent>` and on AWS `previewDomain: p-<id>.<parent>`. Added checks: the `url` output is the domain, the Cloudflare records exist (on AWS the domain and wildcard CNAMEs and two validation records), the first fetch waits up to 15 minutes (DNS and certificates; `fetch` verifies the certificate), the canonical link uses the domain, an AWS preview on `pr-1.p-<id>.<parent>` serves its own canonical URLs and returns 404 after `preview-destroy`, and after `destroy` no record containing the run id is left (listed through the Cloudflare API). The suite timeout is 75 minutes per test. The listing call was smoke-tested read-only against the real zone.

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
2. Me, via MCP: pre-flight on `elchanio-76.eu` (done 2026-10-25): zone active on the Free plan, DNSSEC active, no CAA records (any CA may issue, so ACM and SWA are fine), no wildcard and no records under `sforge.`. The token (loaded from the user's `.envrc` through direnv; `direnv exec .` in non-interactive shells) is an account token: it reads the zone, while `/user/tokens/verify` rejects it as a non-user token.
3. Code B → C → E → D → F with unit and `tofu test` coverage, then `pnpm -r test`, `pnpm test:iac`, `pnpm -r typecheck`, lint.
4. Live domain tests: AWS, then Azure (G). This creates and destroys sandbox resources, so I'll ask before each run.
5. Release `0.2.0-rc.1` (`next`) through the tag workflow (done 2026-10-25; the user added the trusted publisher for `@staticforge/cloudflare`, I pushed the tag).
6. Test repo: `sforge init`, `ci init`, then `provision aws` and `provision azure` locally (admin profile + `CLOUDFLARE_API_TOKEN`), then set variables and run the GitHub flow (verification step 6). Done 2026-10-25; the fixes it needed went out as `0.2.0-rc.2` and the flow passed again on it (F).
7. Fixes found, then release `0.2.0`, then update PLAN.md and commit. Done 2026-10-25.

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

## 18. M10 plan: private sites (AWS + Azure)

### Context
sforge publishes only public sites. A target should be able to require sign-in on every URL, with its custom domain in a public zone or in a private zone on a company network reached over VPN. sforge manages user authentication only, never the network. Firebase Hosting, the other feature planned the same day, follows in M11 (§19).

Decisions (made with the user, 2026-10-26):
- **Azure: Free plan only.** Preconfigured SWA providers (Entra ID `aad`, optionally GitHub). Access is a custom role `member` given through SWA invitations, at most 25 users per app. Restricting sign-in to one tenant, groups, or a custom OIDC provider (including Entra External ID) needs the Standard plan and is left out.
- **AWS: users live in a Cognito user pool.** sforge invites them by email, lists and removes them. Self sign-up is off; no federation (Cognito's free tier covers 10,000 MAU in the pool, but only 50 federated).
- **Scope: the whole target.** A target is public or private; a private target protects every URL (pages, assets, search index, sitemap, the 404 page).
- **Private DNS: records printed for the company's DNS admins.** CloudFront (ACM) and SWA validate custom domains over public DNS, so validation records go in the public parent zone (through `dns`, or printed) and the site's CNAME is printed for internal DNS (AD DNS, Infoblox, …), never published. Route 53 and Azure private zones are not managed. The site stays reachable through its `*.cloudfront.net` / `*.azurestaticapps.net` host, so sign-in is the real protection.
- **Verification:** AWS live tests sign in headlessly as a throwaway Cognito user; Azure sign-in (a real Microsoft or GitHub account with MFA) is checked by the user once.

### A. Config (`packages/core/src/config/schema.ts`)
**Done (2026-10-27).** As built: `allowCloudFrontHost` is a boolean (default false; true also serves and signs in on the `*.cloudfront.net` host). `privateDns` without `domain` is refused by the schema itself (a refinement on each target schema, so `config validate` catches it). New error codes `SF_USER_EXISTS` (exit 2) and `SF_USER_LIMIT` (exit 1).
- `targets.<n>.auth`: its presence makes the target private. Per provider:
  - **AWS:** `{ sessionHours?: 1–24 (default 8), mfa?: 'off'|'optional'|'required' (TOTP, default 'optional'), allowCloudFrontHost?: false }`.
  - **Azure:** `{ providers?: ('aad'|'github')[] (default ['aad']) }`. The role is always `member`.
- `targets.<n>.privateDns: true` (both providers, requires `domain`): the public zone gets only validation records; the site's records go to a new output, `dns_private_records`, which `provision`, `status` and `--json` show as records to add to internal DNS. Independent of `auth`; without `auth`, `provision` warns that the default host stays reachable.
- Private targets build with `noindex` (the build option previews use).
- `pnpm schema:generate`.

### B. AWS (`packages/providers/aws`)
**Done (2026-10-27), not yet run live.** As built, where it differs from the outline below:
- **The Lambda reads the cookie key from SSM, not the KVS.** KVS reads need SigV4A, and the SDK in the Lambda runtime may not ship the `signature-v4a` signer. The key lives in two places: KVS `auth:key` (router) and the SecureString `/sforge/<site>-<target>/auth/key` (Lambda, the `aws/ssm` key, which needs no IAM KMS grant). Both are seeded `none` with `ignore_changes`; `postApply` (and `revoke-sessions`) writes SSM first, then the KVS. No `auth:kid`: a new key invalidates every cookie anyway. Both seeded resources are in `expectedDrift`. Note in the docs: the CI role can read the KVS, so it can read the key.
- **Dependency cycle broken with a settings parameter.** The client's callback URLs need the distribution (without a domain), which needs the function URL, so the Lambda gets its settings (client id, Cognito domain, issuer, hosts, preview suffix, session hours) from a String parameter `/sforge/…/auth/config` named by convention in its environment, not by reference.
- **The router passes the viewer's host to the Lambda** in `x-sforge-host` (the auth behavior uses `Managed-AllViewerExceptHostHeader`, since a function URL must see its own Host). The router is associated with the auth behavior too and returns early there.
- **Cookie format:** `base64url(JSON).hex(HMAC-SHA256)`, claims `{ sub, email, exp, host }`. The router decodes with `atob` (documented global in cloudfront-js-2.0; whether `Buffer` is global was unclear), so the Lambda writes ASCII-only JSON (`\uXXXX` escapes). The **handoff token is a cookie value with an extra `hx` deadline** (60 s): the router checks it on `/_sforge/session` and sets it unchanged as the preview host's cookie, so the router never signs anything. `r` (the return path) must start with `/` and not `//` or `/\`. No computed property names or optional catch bindings in the router (runtime 2.0).
- Comment-only lines are stripped from `router.js` when provisioned (`replace` with a multiline regex in `router.tf`): 6.8 KB with the auth code. A unit test checks the 10 KB limit with a worst-case config, `tofu test` checks the provisioned code.
- Cognito: domain prefix `sforge-<16 hex of sha256(bucket name)>` (prefixes may not contain "aws"); invitation subject and text name `site.title` (new module input `site_title`); `deletion_protection = INACTIVE` so `destroy` works; tokens 60 minutes, refresh 1 day. `aws_cognito_managed_login_branding` with Cognito's defaults. Lambda: Node 24 arm64 128 MB, its own log group (30 days), two permissions for CloudFront (`InvokeFunctionUrl` with `AWS_IAM`, and `InvokeFunction`). The zip is written to the workspace (`archive` provider, added to the spec's required providers).
- `logout` returns to `https://<home>/`, which sends the visitor to sign in again; logout on a preview host clears its cookie and continues on the domain.
- New outputs: `sign_in_url`, `auth_user_pool_id`, `auth_key_parameter`, `dns_private_records`; with `private_dns`, `dns_records` and `dns_routing_records` are empty and Route 53 aliases are skipped.
- Users: `remove` looks the user up with a `ListUsers` filter on `email` (the pool's user names are generated), then `AdminUserGlobalSignOut` + `AdminDeleteUser`.
- Found on the way: `terraform test` (Terraform 1.16.1) fails the existing run `custom_domain_with_route53_and_previews` with "Attempt to get attribute from null value" in `dns_validation_records`, also on the commit before M10; OpenTofu passes all 12 runs. Not fixed in M10.
No Lambda@Edge, and every part fits a free tier: the existing **router CloudFront Function** checks a signed session cookie on every request, and a small **regional Lambda** runs only during sign-in.
- **HCL `modules/site/auth.tf`** (count on `var.auth != null`):
  - `aws_cognito_user_pool` (Essentials tier, admin-create-only, email as username, invitation template naming the site, TOTP MFA per `mfa`, password policy), `aws_cognito_user_pool_domain` (prefix domain, managed login v2), `aws_cognito_managed_login_branding` (default style), `aws_cognito_user_pool_client` (public client with PKCE and no secret, code flow, scopes `openid email`, callback and logout URLs on `https://<domain>/_sforge/auth/…`, or the `cloudfront.net` host without a domain).
  - Sign-in Lambda (`auth-lambda/`, plain JS in the module, zipped by the `archive` provider): Node 24, arm64, 128 MB; a function URL with `AWS_IAM` auth behind a CloudFront OAC of type `lambda`; an `ordered_cache_behavior` for `/_sforge/auth/*` (CachingDisabled, origin request policy forwarding query strings and cookies). Its role reads the KVS only.
  - Session key: KVS keys `auth:key` and `auth:kid`, seeded `none` with `ignore_changes` like `active`. The key never enters state: a new `PreparedTarget.postApply` hook generates 32 random bytes through the SDK when it is `none`.
- **`router.js`** (with `auth` in the substituted config):
  - Verifies `__Host-sforge_session` before routing: `base64url(payload).hmac`, HMAC-SHA256 (available in CloudFront Functions), payload `{ sub, email, exp, host }`, key from the KVS.
  - Missing or invalid → 302 to `https://<domain>/_sforge/auth/login?return=<url>`, also for `/_sforge/errors/404.html` (CloudFront's own error-page fetch bypasses the function, so signed-in users still get 404 pages).
  - `/_sforge/session?t=…` (previews): checks a 60-second handoff token bound to the host and sets the host's cookie.
  - With a domain, the `cloudfront.net` host gets a 301 to the domain.
  - Functions are limited to 10 KB (the router is 5 KB with comments); minify at substitution time if needed.
- **The Lambda:** `login` (state and PKCE verifier in a short signed cookie, redirect to Cognito `/oauth2/authorize`); `callback` (checks state, exchanges the code, verifies the ID token's issuer, audience and `token_use` against the JWKS, sets the session cookie, redirects to `return`, which must be the domain or a preview host; for a preview host it redirects through `https://pr-N.<previewDomain>/_sforge/session?t=…`, so one callback URL serves every preview, as Cognito allows no wildcard callbacks); `logout` (clears the cookie, then Cognito's `/logout`).
- **Caching:** the cache key stays the versioned URI; the viewer-request check runs before the cache. Private targets deploy `revalidate` files with `Cache-Control: private, max-age=0, must-revalidate`.
- **Users** (`src/users.ts`): `AdminCreateUser` (Cognito emails a temporary password; its default sender allows 50 emails a day, documented), `ListUsers`, `AdminDeleteUser` + `AdminUserGlobalSignOut`. A removed user keeps access until the cookie expires (at most `sessionHours`); `sforge users revoke-sessions` rotates the key and signs everyone out.
- **`privateDns`:** only the `dns_validation` records module; the domain and wildcard CNAMEs go to `dns_private_records`.
- The CI role is unchanged: deploys never touch Cognito.

### C. Azure (`packages/providers/azure`)
**Done (2026-10-27), not yet run live.** As built: the catch-all `/*` route comes **last**, after the header and cache routes (each with `allowedRoles: ['member']`); first come the blocked providers and the denied page (`authenticated`). Global `Cache-Control` is `private` for private targets. A project's own `static/staticwebapp.config.json` is refused on a private target (`SF_CONFIG_INVALID`) instead of being used as is. Users are removed with `deleteStaticSiteUser`; `invite` checks existing members (`SF_USER_EXISTS`) and the Free plan's 25 (`SF_USER_LIMIT`), and invites on the custom domain when there is one. The custom domain's `validation_token` is marked sensitive by azurerm, so the module exposes it with `nonsensitive()` (it is published in DNS). With `privateDns` and `dns`, the pre-phase applies the app, the domain and `module.dns_validation` (the TXT record needs the token), then waits for the TXT on the zone's nameservers. Whether azurerm returns from creating a `dns-txt-token` domain before validation completes is assumed, to be confirmed live. New outputs `validation_records`, `dns_validation_records`, `dns_private_records`, `sign_in_url` (module input `auth_provider`).
- **`swa-config.ts`** with `auth`: auth routes first, counted in the 20 KB budget: blocked providers → `statusCode: 404`; `/_sforge/denied.html` → `allowedRoles: ['authenticated']`; `/*` → `allowedRoles: ['member']`. **Every generated route (search CSP, immutable cache) also carries `allowedRoles: ['member']`**: SWA applies only the first matching route, so a header route without roles would bypass auth. `responseOverrides`: 401 → 302 to `/.auth/login/<first provider>?post_login_redirect_uri=.referrer`; 403 → rewrite to `/_sforge/denied.html`, a small accessible page with sign-out that the deployer adds.
- **Users:** invite with `createUserRolesInvitationLink` (role `member`, provider, email for `aad` or username for GitHub, `--expires` 1–168 hours, default 168; SWA sends no email, so sforge prints the link), list with `listStaticSiteUsers` filtered to `member`, remove with `updateStaticSiteUser` (empty role) or `deleteStaticSiteUser`. The 25-user limit is checked before inviting.
- **`privateDns`:** the custom domain uses `validation_type = "dns-txt-token"`; the `_dnsauth.<label>` TXT record goes public (Cloudflare) or is printed; the pre-phase waits for the TXT record instead of the CNAME (`waitForCname` generalized to `waitForRecord`); the CNAME goes to `dns_private_records`.
- The `ci-oidc` custom role is unchanged.

### D. Shared plumbing
**Done (2026-10-27).** As built: `postApply(outputs, logger)` runs after every provision that leaves the infrastructure current (an apply, or a plan without changes), not only after an apply, so a failed seeding is retried; it returns notices. `Provider.createUserAdmin?(context)` returns the `UserAdmin` (it needs the outputs). `users revoke-sessions` is CLI-only (not an MCP tool). The Cloudflare module quotes TXT content.
- IaC layer: `PreparedTarget.postApply(outputs)`, run after a successful apply.
- Cloudflare `records` module: TXT records (also needed in M11).
- `provider-api`: optional `Provider.users?: UserAdmin { list, invite, remove, revokeSessions? }`.
- CLI: `sforge users list|invite|remove|revoke-sessions <target> […]` with `--json` schemas; `remove` and `revoke-sessions` need `--yes`; `SF_UNSUPPORTED` without `auth`. Run with the admin sign-in, never from CI. `provision` shows the sign-in URL and the private records.
- MCP: `sforge_users_list` (read-only), `sforge_users_invite` and `sforge_users_remove` (need `confirm: true`).
- `ci init`: unchanged; previews of private AWS targets work through the handoff.

### E. Tests, live verification, docs, release
**Code and docs done (2026-10-27); live runs passed and 0.3.0 released (2026-10-28).** Unit tests: router + Lambda end to end (`packages/providers/aws/test/auth.test.ts`: the Lambda's cookie and handoff are verified by the router code, ID tokens signed with a generated RSA key), session key and users (`aws-sdk-client-mock`), Azure config/users/profile (`private.test.ts`), the TXT wait, CLI and MCP (envelopes validated against the schemas). `tofu test`: 12 runs (AWS), 10 (Azure), 4 (Cloudflare). `pnpm test:iac` and `pnpm test:pack` pass (the pack test also checks that `router.js` and `auth-lambda/index.mjs` ship). The live test is `packages/cli/test/live-auth.integration.test.ts` (helpers shared in `live-helpers.ts`): `SFORGE_LIVE_AUTH=1`, optional `SFORGE_LIVE_PRIVATE_DNS=1` (Chromium gets `--host-resolver-rules`, Node requests a custom `lookup`), `SFORGE_LIVE_KEEP=1` for Azure's manual check.
- Unit: the router with auth (valid, expired, wrong-host and forged cookies, handoff, redirect, the 404 path), the Lambda handlers (mocked token endpoint and JWKS), the SWA config (every route has `allowedRoles`, the budget holds), the users APIs (`aws-sdk-client-mock`, fake Azure clients), schema rules.
- `tofu test`: auth resources, `privateDns` without routing records, Azure TXT validation; `pnpm test:iac`.
- Live (`SFORGE_LIVE_AUTH=1`, asked before every run):
  - AWS: anonymous → 302 to login; in Chromium (playwright-core) a test user (`AdminCreateUser` + `AdminSetUserPassword --permanent`) signs in through managed login, pages and assets load, a preview loads through the handoff, sign-out works. With `privateDns`: no public routing record (Cloudflare MCP), and the certificate is valid when fetched with the CloudFront address forced (custom `lookup`).
  - Azure: anonymous → 302 to `/.auth/login/aad`, every route of the served config has `allowedRoles`; then by hand (the user): an invited account gets in, a second account sees the denied page, previews too. With `privateDns`: TXT validation and the certificate.
- **AWS live: passed (2026-10-28)**, sixth run, with a custom domain, `privateDns` and `previewDomain` (about 11 minutes). Confirmed: `nodejs24.x`, Cognito managed login (email and password fields found by label), `atob` and `crypto` HMAC in the router, the cookie and the preview handoff, `Cache-Control: private` on pages and assets, `noindex`, sign-out, `revoke-sessions` (old cookie refused within the wait), `users list/remove`; only validation records in Cloudflare; nothing left in the account afterwards. Found and fixed, all in the test: the example's blog collection was missing (feed links broke the pre-deploy check); signing in right after a deploy can hit an edge that has not received the KVS change yet (503 "not deployed", or 404 "no preview" for a preview), so the test now waits for the page itself; Playwright's `page.request` runs in Node, where the browser's host-resolver rules do not apply, so signed-in requests go through the test's `get()` with the browser's cookies. The test prints the redirect trail when sign-in lands on a page without a heading.
- **Azure live: passed (2026-10-28)** with a custom domain (no `privateDns`), the site kept for the user's check: anonymous visitors go to `/.auth/login/aad` on every URL; the user, invited by `users invite --provider github`, got in; a second account saw the denied page. Found and fixed: Azure's sign-in service still answers `/.auth/login/google` and `/facebook` (redirect to its identity service) and `/twitter` (424) on a Free app, so private targets now block those three as well (404); `users remove` deleted the user but failed, because the API answers 204 and `@azure/arm-appservice` 19 accepts only 200 (now treated as success; the fake throws like the SDK). A removed user **keeps access** until they sign out or the SWA sign-in expires (the role is in the session); the CLI message and the docs say so. Adding the custom domain took 11 minutes this time. A second automatic run with `privateDns` passed (about 15 minutes): azurerm returns from creating the `dns-txt-token` domain (29 s) before the TXT record exists, then sforge creates `_dnsauth.<domain>` and waits for it on the zone's nameservers; no public CNAME is published; nothing left behind.
- Docs: new `docs/content/private-sites.md` (users, sessions and revocation, limits, the private DNS split horizon, the reachable default host), `deploy.md`, `mcp.md`.
- Release 0.3.0: rc on `next`, checked in `sforge-ci-test`, then final.
- **0.3.0-rc.1 in `sforge-ci-test`: passed (2026-10-28).** Both targets made private (AWS `auth: {}`, Azure `auth: { providers: ['github'] }`), provisioned locally (AWS 39 resources; Azure's custom domain took 4.5 minutes), `ci init --force` produced the same workflows; only the Azure client ID changed. The user, invited on both, signed in; anonymous visitors went to sign-in. A pull request: SARIF upload, both previews behind sign-in (the AWS handoff from the domain, and the Azure `member` role holds in the preview environment), the comment; closing it removed both previews. The merge deployed (Azure after approval), then a rollback dispatch on each target: both stayed private (the Azure rollback rebuild keeps the access rules). Destroyed afterwards, workflows disabled. Found and fixed: `provision` left the sign-in Lambda's zip (`.sforge-auth-lambda.zip`) untracked in the workspace; the generated `.gitignore` now lists `/.sforge-*.zip`. Open: `npm audit` reports advisories in transitive dependencies of `@staticforge/azure` (`@azure/msal-node` through `@azure/identity`, no fix yet; `adm-zip` through the SWA CLI).

### Order of work
1. Config and schema (A), IaC `postApply` and TXT records (D). Done 2026-10-27.
2. AWS (B): HCL, router, Lambda, users; unit and `tofu test`. Done 2026-10-27.
3. Azure (C): SWA config, users, TXT validation. Done 2026-10-27.
4. CLI `users` command, MCP tools, docs. Done 2026-10-27.
5. Live tests (ask first): AWS, then Azure with the user's manual sign-in check. AWS passed 2026-10-28 (custom domain, `privateDns`, preview, sign-out, `revoke-sessions`, `users remove`; nothing left behind). Azure passed 2026-10-28 with a custom domain (the user's manual check), and again with `privateDns`. Done 2026-10-28.
6. rc release, test repository, 0.3.0. 0.3.0-rc.1 published and checked in `sforge-ci-test` 2026-10-28; 0.3.0 published the same day (the release job needed two re-runs, see RELEASING.md). Done 2026-10-28.

## 19. M11 plan: Firebase Hosting (`@staticforge/firebase`, package 16)

### Context
A third provider, Firebase Hosting, for public sites. Decisions (made with the user, 2026-10-26):
- **Blaze plan within the free quotas, in an existing project.** Since September 2024, Spark projects cannot use any Cloud Storage bucket, so the state (a GCS bucket in the project, like AWS and Azure) needs billing. The user creates the project, links billing and sets a budget alert; sforge does not create projects (global IDs, billing rights, a 30-day reuse block).
- **Public only for now.** Firebase Hosting has no sign-in gate; a real one needs Cloud Run or Functions on every request, or IAP behind a load balancer. `auth` and `privateDns` get `SF_UNSUPPORTED`.
- **Verification** in a new GCP sandbox project, with the domain `firebase.sforge.elchanio-76.eu`.

### A. Config
`{ provider: 'firebase', project, site? (default derived from the project name; globally unique, ≤ 30 characters), domain?, dns?, baseUrl?, retainVersions, previewTtlDays? (default 7), state?: { bucket?, location? (default 'EU') }, ci? }`.

`'firebase'` is added everywhere `'aws' | 'azure'` is hard-coded: the schema union and its types, `providerFor` in `packages/cli/src/cloud.ts`, the enums in `packages/cli/src/schemas.ts`, `init --provider` and the starter target in `packages/build/src/scaffold.ts`, `packages/cli/src/commands/ci.ts` and `packages/cli/src/ci/workflows.ts`, the live tests, docs and `packages/cli/package.json`.

### B. IaC
- Backend: `IacBackend.type` gains `'gcs'` (native locking).
- `state-bootstrap`: bucket `sforge-state-<project>` (uniform access, public access prevention enforced, versioning, soft delete, `prevent_destroy`); the caller gets `storage.objectAdmin` (as built: no binding, see G).
- `modules/site` (`google` + `google-beta`): `google_project_service` for firebase, firebasehosting, iam, iamcredentials, sts, serviceusage (`disable_on_destroy = false`); `google_firebase_project`; `google_firebase_hosting_site`; with `domain`, `google_firebase_hosting_custom_domain` (beta, `cert_preference = GROUPED`).
- DNS: the records Firebase wants (`required_dns_updates.desired`: TXT, A, or CNAME for subdomains, plus ACME TXT) are known only once the domain resource exists. A pre-phase applies the domain with `wait_dns_verification = false` and reads them; the full apply creates them through Cloudflare (the `records` module gains A/AAAA and several values per name) or prints them (`--no-wait`).
- CI (`ci.tf`): a Workload Identity pool and GitHub OIDC provider whose `attribute_condition` pins `repository_id` (immutable subjects, see M9); a service account with `roles/firebasehosting.admin` on the project (Hosting has no per-site role; documented); `storage.objectUser` on the state bucket with an IAM condition on its own object prefixes; `workloadIdentityUser` for the branch, environment and pull-request principal sets. Outputs `ci_workload_identity_provider`, `ci_service_account`.

### C. Deployer (Hosting REST API through `google-auth-library`; no `firebase-tools`)
- Deploy: create a version whose config carries the `security` headers, cache classes as globs from the manifest, `cleanUrls`/`trailingSlash` from `build`, and the search CSP on `/search` and `/pagefind`; `populateFiles` with the SHA-256 of each gzipped file; upload only the missing ones (16 at a time); finalize; release on `live`, labelled with the version id `<UTC>-<sha>`.
- Previews: channel `pr-N` with TTL `previewTtlDays`; `previewBaseUrl` creates or reads the channel so the build gets its URL (`<site>--pr-N-<hash>.web.app`); `preview-destroy` deletes it.
- Versions and rollback: Firebase's own release history. `versions` lists releases; rollback releases the earlier version (seconds, no rebuild); `retainVersions` sets the site's `maxVersions`. No `versions.json`.
- 404: Firebase serves `404.html` itself.
- URL semantics: compared live with `resolveRequest` for both `trailingSlash` modes; differences documented.

### D. CI and the rest
- `ci init`: `google-github-actions/auth` in `actions.ts` and `scripts/ci-pins.mjs`; variables `SFORGE_<T>_WORKLOAD_IDENTITY_PROVIDER` and `SFORGE_<T>_SERVICE_ACCOUNT`; previews always available, as on Azure.
- Docs: Firebase in `deploy.md`, `ci.md`, README, RELEASING (the new package's first publish is by hand, then its trusted-publisher entry).

### E. Prerequisites (the user) ✅ done 2026-10-30
- A new GCP project with billing linked and a budget alert.
- The gcloud CLI, `gcloud auth application-default login`, Owner on the project.
- `gcloud auth application-default set-quota-project <project>`: Firebase's APIs bill a user login's calls to a quota project.
- The Firebase Terms accepted once for the account (https://console.firebase.google.com/?forceCheckTos=true). No API, CLI or Terraform can do this.
- `serviceusage`, `cloudresourcemanager` and `storage` APIs enabled by hand: Terraform needs them before it can enable anything else, and `state-bootstrap` runs before the site module.
- The existing Cloudflare token already covers TXT and A records.

### F. Verification
- Unit: the deployer against a fake Hosting API (hashing, partial uploads, channels, rollback), config, `ci init` for Firebase (output through actionlint).
- `tofu test` for the site, state-bootstrap and CI modules; `pnpm test:iac` with both engines.
- Live (`SFORGE_LIVE=firebase SFORGE_LIVE_CONFIRM=<project id>`, asked before every run): bootstrap, provision, two deploys, HTTP checks (headers, redirects, 404, `.sforge/` hidden), a preview channel and its removal, rollback, destroy. Domain mode on `t-<id>.firebase.sforge.elchanio-76.eu`. Site IDs get a random suffix (deleted IDs are not immediately reusable).
- `sforge-ci-test`: a Firebase target, then the PR, merge, close and rollback flow.
- `pnpm test:pack` (16 packages), then 0.4.0 (rc first).

### G. Progress
Status 2026-10-31: code, mocked tests and docs are written. The live cycle without a domain passes on the final code. In the last domain run everything about the domain passed (provision, certificate, the plan right after it and the later one both clean, deploys, HTTP checks, rollback, cleanup). The run still failed, on the preview 404 below. The user decided custom domains stay, and accepted the preview failure on domain targets as a documented known issue (`deploy.md`): it no longer blocks the release, and it stays unexplained. `sforge-ci-test` is verified with `0.4.0-rc.1`. **Done: `0.4.0-rc.1` (`next`) and `0.4.0` (`latest`), both 2026-10-31**, the latter with a Dependabot update (#8) on top of the rc.

As built, differing from A–D:
- CI identity is its own module, `modules/ci-oidc` (as on Azure), not `ci.tf` in the site module, so `hashicorp/random` is needed only with `ci`.
- The pool's `attribute_condition` is `assertion.sub.startsWith('<subject prefix>:')` rather than a `repository_id` comparison: the prefix holds the immutable IDs where GitHub uses them, and it needs no extra lookup for older repositories. Members are exact `principal://…/subject/<sub>`, not principal sets.
- The pool ID has a random suffix: a deleted pool blocks its ID for 30 days.
- State access for CI is `storage.objectViewer` (it only reads outputs), not `objectUser`. The condition also allows the bucket resource, because listing is checked against the bucket.
- Header rules use RE2 `regex` rather than globs, except the `**` rule: built paths can hold characters that globs treat specially. At most 1,000 rules; the rest revalidate, with a warning.
- `Deployer.previewBaseUrl` may now return a promise and takes `{ dryRun }`: the channel URL holds a hash only Firebase knows, so a real deploy creates the channel before the build, and a dry run only reads it.
- `IacSpec.imports` / `PreparedTarget.imports`, and `purpose: 'plan'`. **Projects that already use Firebase**: `prepare` asks the Firebase API, and if Firebase is on, `provision` adds an `import` block for `google_firebase_project`. Checked with both engines (on `random_id`): the block is a no-op once the resource is in state, and destroy plans ignore it. Status and destroy do not get the block.
- The Cloudflare records have keys Firebase decides, unknown until the domain exists, and a map's keys must be known when planning. `provision` creates the domain first (the pre-phase). A plan with no pre-phase (`--diff`, status, destroy) leaves the DNS module out until the domain exists; `--diff` on a new target logs that it cannot show them.
- `postApply` waits up to 30 minutes for the certificate, then returns a notice instead of failing: the site already works at `*.web.app`.
- `immutableRoutes` and `hstsValue` moved from the Azure provider to `provider-api`, to be shared. `sforge init` gains `--project`.

Found live:
- `google_client_openid_userinfo` returns a null email with `user_project_override`: Google's OpenID endpoint refuses the quota project header (403 `USER_PROJECT_DENIED`) and the provider hides the error. So `state-bootstrap` no longer gives the caller `storage.objectAdmin`: project owners and editors get the objects through a new bucket's default legacy roles, which bootstrapping proves when it moves its state in.

- Settled by the live cycle: a later header rule overrides an earlier one (`**` sets revalidation, later rules set `immutable`); `ADD` and `REMOVE` redirect pages as `resolveRequest` does and leave files alone; 404 pages; version labels accept the characters used; `tofu output` and the state bucket work for a user login.
- Adding Firebase creates a `DEFAULT_SITE` named after the project, which sforge did not ask for and which stays. A target whose `site` is the project ID would collide with it.

- Domain mode: Firebase asks for one CNAME on a subdomain, and an `_acme-challenge` TXT from `cert.verification.dns`, which Google describes as a way to get a certificate *before* pointing traffic at Hosting. It is not managed: the certificate is issued without it. Provision with a project that already has Firebase works through the import block.
- With only the CNAME, the certificate is still issued and a second plan is clean. Timing varies: about 37 minutes in one run, 9 minutes in the last. The wait is now 45 minutes (30 expired in two runs). For a while after the first HTTPS answer, some edges still present `*.firebaseapp.com`: documented, and the test now requires stable answers on fresh connections.
- **Intermittent preview 404, cause unknown.** 3 of 12 new channels never served during the test's wait, in 3 of 5 domain runs (`pr-1` at `/` once, `pr-2` at `/about` twice; two minutes the first two times, ten minutes the last), while the others answered within a second. All 3 were in domain runs, but only 2 channels ran without a domain, which is too few to say the domain matters. The answer is Firebase's own "Site Not Found" (`cache-control: max-age=0`, `x-cache` MISS then HIT), not the site's 404 page: so the host had no content, rather than a file being missing. Ten minutes rules out ordinary propagation. The live test now reads the channel and its releases through the API on a failure, and `SFORGE_LIVE_PREVIEW_TRIALS=<n>` measures the rate with or without a domain. A no-domain run with 10 trials on the final code: 12 of 12 channels served within a second. In all: 3 of 10 channels failed with a domain, 0 of 14 without. That points at the domain but does not prove it (about 6% by chance), and the API diagnostics have not yet seen a failing channel. Trials on a domain target would be the next step if it is picked up again.

- **Fixed: the next provision would have deleted the live site's CNAME.** Once a domain is active, Firebase stops listing the record in `required_dns_updates`, and the module followed that list (a second plan showed the record's `delete`). The plan's approach (D: read `desired`, pre-phase, several values per name, A/AAAA in the Cloudflare module) is replaced: `modules/site` computes one CNAME to `<site>.web.app`. Checked against the logged records' hashes. That needs no pre-phase with a DNS provider, so `--diff` shows the record from the start, and the Cloudflare module is back to CNAME and TXT. An apex gets `SF_UNSUPPORTED`, as on Azure: its records could not be verified. The live test now plans again after the certificate.
- Verified live: with the computed CNAME, the plan right after provision and the one after the certificate both show no changes.
- `cert.state` is unreliable for waiting: it did not report active at 46 minutes while HTTPS answered with a valid certificate. `postApply` now asks the domain itself, and its notice on timeout includes Firebase's states.

To settle live (assumptions the mocked tests cannot check):
- `ownershipState`/`hostState` as the wait without a DNS provider: never observed, because live runs use Cloudflare.
- `sforge-ci-test` (`0.4.0-rc.1`, reviewed `production` environment plus pull requests, no domain; provisioned in 61s): PR previews with the channel's URL in the comment, canonical links and `noindex`; deploys after the reviewer's approval; preview cleanup on merge; rollback through the workflow, also reviewed. The identity needs no more than `firebasehosting.admin` and `objectViewer` on its own state: `tofu init` and outputs work with that, so that assumption is settled. Then destroyed; the workflows are disabled again and the variables removed.
- Also seen: on `*.web.app`, Firebase sends its own `Strict-Transport-Security`, whatever `security.hsts` says (documented). `fileCount` and `versionBytes` read 0 for a few minutes after a release (documented). The first publish of a new package also sets its `latest` tag, so `@staticforge/firebase` has `latest: 0.4.0-rc.1` until 0.4.0.
- `maxVersions` does not let preview versions push production ones out (not exercised: the cycle has too few versions).
- The import path for a project that already uses Firebase: the sandbox now has Firebase on, so the domain run exercises it.

## 20. M12 plan: code review (quality, security, CLI ↔ MCP parity)

### Context
staticforge has grown through M0–M10 to 15 packages: about 17,000 lines of TypeScript (cli 3.9k, build 2.3k, checker 2.1k, azure 1.9k, iac 1.8k, aws 1.3k, core 1.1k, the rest under 1k each), the default theme, the HCL modules (AWS, Azure, Cloudflare, state bootstrap), the CloudFront router function and the sign-in Lambda, the `ci init` workflow templates, and the repository's own CI and release workflows. Each milestone was reviewed as it landed; no review has looked at the whole. M12 does that, in three parts: quality, security, and parity between the command line and the MCP server. It does not depend on M11; run first, it gives the Firebase provider a reviewed base to copy from.

Not in scope: new features, the theme's visual design, and rewrites. A finding that needs a redesign gets a plan of its own.

### A. Method
- **Findings log**: `REVIEW.md` in the repository root (committed). One entry per finding: id (`Q-n`, `S-n`, `P-n`), area and `file:line`, severity (critical, high, medium, low, info), what is wrong and how it shows, the decision, and the commit that fixes it or the reason it is deferred. PLAN.md keeps a summary and the "As built" notes, as for M9 and M10.
- **Fixes**: one commit per finding or per small group of findings, each with a test that fails before the fix where the finding is a bug. Behavior changes are noted in the docs and in the release notes.
- **Baseline first**: run the tools below on the current `main` and record the numbers in `REVIEW.md`, so the review can show what changed.
- **Severity guide**: critical and high are fixed in M12; medium are fixed unless the fix is a redesign (then deferred with a plan); low and info are fixed when cheap, otherwise listed.
- Aids, not substitutes for reading the code: the `/security-review` and `/code-review` skills on each package, and the tools in B–D.

### B. Dependency audit (the `npm audit` findings)
`pnpm audit --prod` on `main` (0.3.0) reports 13 advisories (8 high, 3 moderate, 2 low). All of them arrive through `@azure/static-web-apps-cli` 2.1.0 (the latest), a dependency of `@staticforge/azure`:

| Package | Advisories | Path | Patched |
|---|---|---|---|
| `adm-zip` | 5 high, 3 moderate (decompression bombs, symlink and SUID handling on extraction, duplicate entries, an async crash) | `swa-cli > adm-zip` | ≥ 0.6.1 |
| `node-forge` | 1 high (RSA PKCS#1 v1.5 signature check) | `swa-cli > selfsigned > node-forge` | ≥ 1.4.1 |
| `tmp` | 1 high (path traversal through prefix/postfix), 1 low (symlink `dir`) | `swa-cli > devcert > tmp` | ≥ 0.2.6 |
| `@azure/msal-node` | 1 high (authorization code flow may send parameters to an attacker's endpoint) | `swa-cli > @azure/identity > @azure/msal-node` | ≥ 7.1.0; `@azure/identity` 4.14.0 still requires `^6` |
| `deepmerge` | 1 low (prototype poisoning) | `swa-cli > json-schema-library > deepmerge` | none |

`@staticforge/azure` uses the SWA CLI for one thing: `uploader.ts` spawns `swa deploy`, which downloads and runs Microsoft's StaticSitesClient. Steps:
1. **Reachability**: for each advisory, establish whether `swa deploy` reaches the vulnerable code (adm-zip probably extracts the StaticSitesClient download; devcert, selfsigned and node-forge belong to the local emulator's certificates; msal-node to `swa login`, which sforge never runs because it passes the deployment token). Separately, check whether sforge's own `@azure/identity` (direct dependency, same msal-node `^6`) uses the authorization code flow anywhere (it should only use the Azure CLI and environment credentials). Record each verdict in `REVIEW.md`.
2. **Decide on the SWA CLI**: (a) drop it and download StaticSitesClient directly: pinned version, checksum checked against Microsoft's release metadata, cached under `~/.cache/staticforge/bin/` like OpenTofu. This removes all 13 advisories and a large dependency tree from every install, including AWS-only users of the `staticforge` package; (b) keep it and wait for upstream; `pnpm.overrides` do not reach users who install from npm, so they are not a fix. Recommendation: (a), if StaticSitesClient's download and flags can be pinned reliably; prove it with the Azure live test (asked first).
3. **Guard in CI**: a `pnpm audit --prod --audit-level=high` step that fails on any high or critical advisory not listed in an allowlist file (`audit-allowlist.json`: advisory id, reason, review date). Also audit the dev dependencies (reported, not blocking).
4. Also covered: Dependabot or Renovate for npm, GitHub Actions and the OpenTofu providers (the lock files); the pinned action SHAs in `scripts/ci-pins.mjs` and the repository's workflows are current.

### C. Code quality review
Per package, in dependency order (core, content, render, assets, build, checker, dev-server, server, theme-default, provider-api, iac, cloudflare, aws, azure, cli):
- **Conventions** (CLAUDE.md): `SforgeError` with a stable `ErrorCode` and a `hint` everywhere an error reaches the user; no bare `throw new Error` on user paths; optional fields by spreading; comments that explain why; names consistent across providers (the AWS and Azure deployers, users and IaC profiles should read alike).
- **Structure**: layering (core and provider-api import no provider; providers do not import each other or the CLI), cycles, duplicated logic between the AWS and Azure providers that belongs in provider-api or iac, long functions in `cli` and `build`.
- **Types**: `as` casts, non-null `!` assertions and `unknown` narrowing on external data (cloud SDK responses, config, front matter); count them in the baseline and justify or remove each.
- **Tests**: coverage per package (`vitest --coverage`, v8; baseline recorded, no gate yet), untested modules (for example `packages/server/src/static-server.ts` has no test of its own), and the three known flaky dev-server tests (CLAUDE.md): find the cause and fix them.
- **Unused code**: unused files, exports and dependencies (`knip`).
- **Consistency of the command line**: flags for the same idea should match. Known: `destroy` takes `--confirm <target>`, `users remove` and `revoke-sessions` take `--yes`; decide whether the difference is deliberate (destroy asks for the name on purpose) and document it, or align.
- **HCL modules**: `tofu validate` and `tflint`, variable descriptions and validations, naming and tagging alike in AWS and Azure. Known and open: on Terraform 1.16.1 `terraform test` fails the AWS run `custom_domain_with_route53_and_previews` (OpenTofu passes); the "Drift detected" log lines after an apply are cosmetic and not filtered.
- **Release tooling**: `scripts/publish.mjs` could wait and retry on the two 409s seen with 0.3.0 (RELEASING.md) instead of failing the job.
- **Docs against behavior**: README's command list and every `docs/content/*.md` page against `--help` and the code.
- Tools added as dev dependencies and scripts where they earn their place (`knip`, coverage); one-off runs otherwise.

### D. Security review
Threat model first (a short section in `REVIEW.md`: assets, actors, trust boundaries: the project's own files and config are trusted, as the config is code; content from contributors in pull requests, cloud responses, MCP clients and the network are not). Then, by area:
1. **Private sites (M10)**:
   - AWS router function: the cookie's HMAC check is constant-time, the expiry is enforced and the host is bound.
   - Cookie attributes: `Secure`, `HttpOnly`, `SameSite`, host-only.
   - The `return` parameter cannot redirect to another site (open redirect).
   - The preview handoff link: one minute, bound to a host, replay within the minute.
   - The sign-in Lambda: `state`, PKCE and `nonce`; ID tokens verified against the JWKS with issuer, audience and expiry.
   - The session key: SSM SecureString and the KVS, which the CI role can read (documented); `revoke-sessions`.
   - Azure: every route of the generated `staticwebapp.config.json` has `allowedRoles`; the blocked providers; the 401 and 403 overrides; the refusal of a user's own config file on private targets.
2. **Cloud identities**: the AWS CI role's policy and trust (OIDC subject with the immutable prefix, branches, environments, pull requests); the Lambda's role; the bucket policy (OAC only) and public access block. Azure: the custom role on one Static Web App, the ABAC condition on the state blobs, the federated credentials. Compare each with what the code calls (CLAUDE.md: code in CI must not call anything wider).
3. **Secrets**: the Azure deployment token never reaches logs, `--json` output or MCP progress messages; the Cloudflare token likewise. `uploader.ts` passes the whole process environment to `swa deploy` (a downloaded binary), including any AWS keys and the Cloudflare token present: give it only what it needs. The same check for every `spawn` (OpenTofu, Terraform, git, Chromium).
4. **Input handling**:
   - Paths from content and config: slugs, `new <kind> <path>`, files copied from `static/` (symlinks out of the project), output directories.
   - The dev and preview servers: path traversal, dot paths, the address they listen on, and the live-reload endpoint.
   - Rendering: escaping of titles, descriptions and front matter in templates, the search index, feeds and the sitemap; what raw HTML in Markdown can do (allowed by design; documented).
   - The checker's headless Chromium: sandbox, and no network beyond the local server.
5. **The MCP server**: the infrastructure tools appear only with `--allow-infra`; deploy, rollback, preview removal and user changes only with `confirm: true`; tools cannot write outside the project (`sforge_new_page` paths); tool output carries site content back to the agent (prompt injection: documented in `mcp.md`); no secrets in results or logs.
6. **Workflows and supply chain**:
   - The repository's CI and release workflows, and the `ci init` templates, through `zizmor` and `actionlint`: permissions, pinned actions, script injection through `${{ github.* }}` expressions in `run:` steps, `pull_request` versus `pull_request_target`, and forks (no OIDC token, no previews).
   - Release provenance and trusted publishing; the pre-push secret scan.
7. **Infrastructure defaults**: TLS policies (CloudFront minimum protocol, Azure), security headers (HSTS, CSP for search, frame options), bucket encryption and versioning, state bucket and storage account settings; `trivy config` or `checkov` over the HCL as a cross-check.
8. Turn on GitHub code scanning (CodeQL default setup) for the repository, and a secret scanning check; fix or dismiss what it reports, with reasons.

### E. CLI ↔ MCP parity
The MCP tools call the CLI's own `run()` in-process (`packages/cli/src/mcp/invoke.ts`), so behavior is shared by design; drift can still come from the argument mapping, defaults, output schemas, error handling, and commands without a tool.
1. **Inventory** (a table in `REVIEW.md`, and its stable part in `docs/content/mcp.md`): every command, subcommand and option, and the tool and parameter that maps to it, or the reason there is none. The starting point:
   - Mapped: `build`, `check` (and `check --fix` / the fix preview), `dev` (start and stop), `new`, `config show`, `schema`, `deploy`, `status`, `versions`, `rollback`, `preview-destroy`, `users list|invite|remove`, and with `--allow-infra` `provision` and `destroy`.
   - CLI only: `init`, `preview`, `iac`, `ci init`, `config validate`, `users revoke-sessions`, `version`, `mcp`.
   - Each CLI-only command is either given a tool or listed as deliberate with the reason (for example `iac` passes raw arguments to OpenTofu).
2. **Mapping checks**: each tool parameter becomes the right flag with the same default; enum values match; the confirmation rules match (`--yes`, `--confirm <target>` versus `confirm: true`); global options (`--config`, `--cwd`, `--quiet`) behave the same.
3. **Output and errors**: a tool's structured result equals the `data` of the command's `--json` envelope; its output schema is the one `sforge schema` publishes; failures carry the same `SF_*` code and hint, and `isError` matches a non-zero exit.
4. **Parity test suite** (`packages/cli/test/parity.test.ts`): table-driven, one row per mapped tool. Each row runs the command with `--json` and the tool through an in-memory MCP client on the same fixture site, with the fake providers already used by `mcp.test.ts` for the cloud tools, and compares the results after normalizing times, temporary paths and ports. Error rows do the same for a failure of each kind (usage, config, not provisioned, unsupported, user exists).
5. **Drift guard**: a test that walks the commander program and the registered tools and fails when a command or option has neither a mapping nor an entry in the CLI-only list, so a new command cannot drift silently.
6. **Acceptance**: the whole suite passes, including `cli.test.ts`, `mcp.test.ts` and the new parity tests; every difference found is either fixed or documented in `REVIEW.md` and `mcp.md`.

### F. Order of work
1. Baseline: tools (coverage, knip, dependency layering, zizmor, actionlint, tflint, trivy, `pnpm audit`), numbers into `REVIEW.md`, code scanning on.
2. Dependency audit (B): reachability, the SWA CLI decision, the CI audit guard.
3. Security review (D), highest risk first: private-site sign-in, secrets and spawned processes, the MCP server, workflows, input handling, infrastructure defaults.
4. CLI ↔ MCP parity (E): inventory, parity suite, drift guard, fixes and docs.
5. Code quality review (C), package by package; the flaky tests.
6. Release.

### G. Verification and release
- All checks from CLAUDE.md: format, lint, typecheck, the full suite, `pnpm test:iac` and `tofu test` for changed modules, the docs build and check, `pnpm test:pack`, actionlint on the `ci init` output.
- `pnpm audit --prod` shows no high or critical advisory outside the allowlist.
- Live tests only where fixes change cloud behavior (the uploader if the SWA CLI goes, the router or Lambda if the sign-in changes), asked before every run; then the `sforge-ci-test` flow if a template changed.
- A patch release (rc first): 0.3.1 if M12 lands before M11. Done: `0.3.1-rc.1` (`next`) and `0.3.1` (`latest`), both 2026-10-29.

### As built (M12)

**F.1 Baseline: done.** Numbers and the first findings are in `REVIEW.md` (S-1 to S-4, Q-1 to Q-4). Coverage tooling added (`@vitest/coverage-v8`). `actionlint` is clean; `zizmor` found unpinned actions in `ci.yml`. Not run yet: `tflint`, `trivy`/`checkov` (not installed), and turning on CodeQL code scanning (a repository setting, needs the user's go-ahead).

**Trivy and CodeQL: done.** `tflint` and `trivy config` ran over the HCL (REVIEW Q-5, S-5 to S-8); all trivy findings are accepted with reasons. **Deferred:** an optional CloudFront access-logging feature (off by default, new logging bucket); not valuable enough for this version. CodeQL default setup was enabled on `elchanio-76/sforge`; its first results get triaged under D.8.

**B Dependency audit: done** (live test pending approval). Reachability verdicts are in REVIEW S-10 and S-12. Decision (a): the SWA CLI is gone; `@staticforge/azure` downloads the pinned `StaticSitesClient` (`client.ts`, SHA-256 embedded, `stable` metadata only as a fallback) and starts it with the variables `swa deploy` sets, plus a minimal environment (S-11). The audit shows one high advisory left (`@azure/msal-node` via `@azure/identity`, unreachable), allowlisted in `audit-allowlist.json`; CI has an `audit` job (`scripts/audit-guard.mjs`) and Dependabot is configured. Found: the client's success line is `Visit your site at: <url>`, not the CLI's "Project deployed to"; the URL is optional in the result, so the live test must confirm it. Still to do under B.4: check the pins in `scripts/ci-pins.mjs`.

**D Security review: done except the points below.** Findings S-14 to S-27 in `REVIEW.md`. Fixed: the router's handoff redirect (control characters), the headless checker's network (blocked), rollback hashes (validated), unpinned workflow actions, a ReDoS in the HTML document test (found by CodeQL, confirmed), and five smaller regex alerts. Checked without change: the sign-in Lambda (PKCE, state, ID token verification; no nonce, accepted), the cookie and its MAC, Azure's roles, the static server (first tests), `sforge new` paths, the MCP confirmation rules, rendering escapes, IAM policies, TLS and bucket defaults. Open: S-27 (secret scanning and push protection are off; owner's decision), the Azure live test (Azure uploader), and a `pnpm test:iac` run after the router change (see below). Docs gained "Raw HTML and trust" (`content.md`) and "Safety" (`mcp.md`).

**E CLI ↔ MCP parity: done.** Inventory in `REVIEW.md` and `docs/content/mcp.md` ("Commands without a tool", "Differences from the CLI"); findings P-1 to P-6. `packages/cli/test/parity.test.ts` runs 34 rows through `--json` and the tool on identical fixtures (data, error code, hint, files left behind) plus a drift guard (every command mapped or listed with a reason, tools equal the mapped set, every option of a mapped command has a parameter or a reason). Fixed: refused confirmations now carry the error as JSON like every other failure (P-1); `users revoke-sessions` got `sforge_users_revoke_sessions` (P-2). Deliberate and documented: `confirm: true` ordering and hints, a few defaults, options without a parameter, argument validation errors without an `SF_*` code. `status`, `provision` and `destroy` beyond their refusals need the IaC engine and stay covered by `cloud.test.ts`.

**C Code quality: done** (findings Q-1 to Q-10). Fixed: unused dependencies and exports (Q-2, Q-3), the unused Terraform variable (Q-5), `publish.mjs` retries (Q-1), and the cause of the flaky dev-server tests (Q-6: `close()` raced the background search-index write; 12 parallel runs clean). Reviewed and left: casts and `!` (Q-7), bare errors (Q-8), `--confirm` versus `--yes` (Q-9), README and docs against `--help` (Q-10). **Not done:** the Terraform 1.16.1 `terraform test` failure of `custom_domain_with_route53_and_previews` (needs a Terraform run, slow network), the cosmetic "Drift detected" lines. Remaining for M12: B.4 pin check, S-27 (owner), the Azure live test (needs approval), release.

**M12 follow-ups (2026-10-29).** S-27 done: secret scanning, push protection, vulnerability alerts and Dependabot security updates are enabled. The Azure live test passed with the new `StaticSitesClient` uploader (run `aulwwd`, 7 minutes: client downloaded and checked against the embedded SHA-256, uploads to production and `pr-1`, rollback by rebuilding `0457454`, destroy; only `sforge-state` is left). B.4: the pins in `packages/cli/src/ci/actions.ts` are current and equal those of `.github/workflows`. Pushed; CodeQL closed all six alerts.

**Dependabot review (2026-10-29).** Merged setup-opentofu 2.0.2, unist-util-visit 5.2.0 and chokidar 6 (dev-server tests clean three runs in a row; chokidar 6 needs Node 22.22, as `engines` already does). `@types/node` 26 was refused: types stay on the oldest supported Node, and Dependabot ignores major bumps. azurerm is now `>= 4.0, < 5.12`: the real cap is `AZURERM_PROVIDER` in `packages/providers/azure/src/iac.ts`, not the modules' `versions.tf` (the Dependabot PRs touched only those). The live test first ran on 4.81.0 because of that cap; after widening it, it passed on 5.11.0 (production and `pr-1` uploads, rollback, destroy; only `sforge-state` left), and `tofu validate`/`tofu test` pass for all three modules. azurerm 5 needed no code change: `iac.ts` already sets `resource_provider_registrations: 'none'` and lists the providers, and the storage account sets `min_tls_version` and `allow_nested_items_to_be_public` explicitly. Not covered live: the state-bootstrap and ci-oidc modules.

**Released (2026-10-29).** `0.3.1-rc.1` and then `0.3.1` through the tag workflow (pinned `npm@11.21.1`, trusted publishing): all 15 packages on npm, `latest` = 0.3.1, a clean install passes `npm audit --omit=dev` with 0 vulnerabilities (13 before M12). 0.3.1 includes the Dependabot outcomes above (azurerm up to 5.11). Still open, unchanged: the Terraform 1.16.1 `terraform test` failure of `custom_domain_with_route53_and_previews` and the cosmetic "Drift detected" lines. M12 is closed.
