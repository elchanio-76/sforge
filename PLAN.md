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
| Assets | `sharp` (images → AVIF/WebP + srcset), `esbuild` (JS bundle/minify), `lightningcss` (CSS minify/autoprefix), content-hash fingerprinting |
| Search | Pagefind (post-build index, runs fully client side) |
| Dev server | `node:http` static server + `chokidar` 5 watcher + Server-Sent Events live reload (no WebSocket dependency); full rebuild into a temp dir per change (incremental rebuilds deferred to M8) |
| Checker | `html-validate` 11 (`standard` + `a11y` + `document` presets), `axe-core` in headless Chromium driven by `playwright-core` (no browser download at install; `chromium-headless-shell` installed on demand), custom source and output rules (links, landmarks, headings, lang/title, media), `diff` for `--dry-run` |
| Provisioning (IaC) | **HCL modules** shipped in the package, run by **OpenTofu** (default; pinned version, downloaded and SHA256-verified into `~/.cache/staticforge/bin`) or **Terraform** from PATH (`iac.engine`). Driven by spawning the CLI with `-json` output, which is parsed into progress events and outputs |
| AWS runtime | AWS SDK v3 (`client-s3`, `client-cloudfront`, `client-cloudfront-keyvaluestore`, `client-sts`) for deploy, rollback and previews |
| Azure runtime | `@azure/arm-appservice` (Static Sites secrets/environments), `@azure/identity`, SWA content deploy via `@azure/static-web-apps-cli` deploy client |
| IaC quality | `tofu fmt -check`, `tofu validate`, `tflint`, `checkov`/`trivy config` and `tofu test` with mocked providers |
| MCP | `@modelcontextprotocol/sdk` (stdio transport) |
| Tests | `vitest` (unit), Playwright test (e2e preview + a11y), `aws-sdk-client-mock`, snapshot tests of built output |
| Lint | ESLint + Prettier, `tsc --noEmit` |

## 2. Repository layout (pnpm monorepo)
```
packages/
  core/            # config, diagnostics type, logger, errors (no dependencies on other packages)
  content/         # front-matter, md→hast and html→hast, a11y transforms, fragment/document detection
  render/          # Nunjucks env, theme loader, layout resolution
  theme-default/   # accessible default theme (published package, resolved for theme: "default")
  build/           # discovery, routing, link resolution, orchestration, output + manifest, init/new scaffolding
  assets/          # image/js/css processing, fingerprinting, manifest
  site-features/   # nav, sitemap/robots, collections, tags, pagination, RSS/Atom, Pagefind
  server/          # static file server with production URL semantics (resolveRequest); used by dev, preview and the checker
  checker/         # source/output/rendered rules, de-duplication, autofixes, reporters (pretty/json/sarif/junit)
  dev-server/      # watcher, temp-dir builds, SSE live reload, problems overlay, preview
  providers/
    provider-api/  # Provider interface + shared deploy logic (diffing, manifest)
    iac/           # engine resolver/downloader, workspace generator, tofu/terraform runner, state bootstrap
    aws/           # deployer, versions, rollback, previews (SDK)
      terraform/   # HCL: modules/site (S3+OAC+CloudFront+KVS+function), modules/cert, modules/ci-oidc, state-bootstrap/
    azure/         # deployer, previews, rollback (SDK)
      terraform/   # HCL: modules/site (SWA + domain), modules/ci-oidc (azuread), state-bootstrap/
  mcp/             # MCP server wrapping core commands
  cli/             # `sforge` binary (commander), output formatting, exit codes
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
  targets: {
    staging: { provider: 'aws', region: 'eu-central-1', domain?: 'staging.example.com', hostedZone?: 'example.com', retainVersions: 10 },
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
5. **Site features**: nav tree (dir structure + front-matter order; `aria-current="page"`; breadcrumbs with `nav aria-label="Breadcrumb"`), collections with pagination (`rel=prev/next`), tag pages, RSS 2.0 + Atom, `sitemap.xml`, `robots.txt`, `404.html`.
6. **Assets**: esbuild bundles `assets/js/*.ts|js` entrypoints (ES modules, `type="module"`), lightningcss processes theme and user CSS, sharp produces image variants. Everything is content-hashed and recorded in `asset-manifest.json`. References in HTML are rewritten.
7. **Post-process**: Pagefind index (`data-pagefind-body` on `<main>`), HTML minify (whitespace-safe) and a final serialization check that the output re-parses cleanly.
8. **Write** `dist/` plus `dist/.sforge/build-manifest.json` (file → sha256, content-type, cache class). Deploy diffs use this manifest.
9. Incremental mode (dev): a dependency graph so only affected pages re-render.

**Headless-testability conventions** (baked into the default theme and enforced by the checker): a unique `id` on `main`, landmarks, stable `data-testid` hooks on theme components (nav, search, pagination, theme toggle), a logical heading tree, labelled form controls, and no content that only exists after JS (search is progressive enhancement).

## 5. Default theme (`themes/default`)
- Layouts: `base`, `page`, `post`, `list`, `tag`, `404`; partials `header`, `nav`, `footer`, `breadcrumbs`, `pagination`, `search`.
- CSS: custom properties for tokens, `prefers-color-scheme` + `prefers-reduced-motion`, visible `:focus-visible`, AA contrast verified by the checker, responsive layout.
- JS: tiny optional module for the mobile nav toggle (`aria-expanded`) and the Pagefind UI.
- Theme contract documented in `docs/themes.md` (required blocks, available context, `theme.json` manifest: name, version, layouts, default layout).

## 6. Checker (`packages/checker`) — `sforge check [--fix [--dry-run]] [--headless|--no-headless] [--pages <globs…>] [--format pretty|json|sarif|junit] [--output <file>] [--fail-on] [--drafts]` ✅ (M3)
User documentation: `docs/checker.md`.

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

**Never invents alt text.** Not implemented, with reasons: `rel="noopener"` (browsers imply it for `target=_blank`; the build already adds the new-tab notice to content links); id de-duplication (renaming ids breaks `#fragment` links elsewhere); image width/height (moves to M4, where sharp reads dimensions during the build); landmark `aria-label`s and decorative `alt=""` (need author intent). Theme templates are never edited.

**Reporters**: `pretty` (grouped by file; a problem at the same selector on several pages is listed once, as likely theme-caused), `json` (the `CheckResult`, also the `--json` envelope's `data`; schema: `sforge schema diagnostics`, `$id urn:staticforge:schema:diagnostics:v1`), `sarif` 2.1.0 (URIs relative to the git root; problems without a source fall back to the config file; stable `partialFingerprints`), `junit` (failures = at or above `failOn`). `--output` writes the report to a file; `--json` with sarif/junit requires `--output`.

**Diagnostic shape** (shared with the build): `{ ruleId, severity, message, file?, line?, column?, url?, selector?, wcag?, fixable?, hint?, helpUrl? }`. Config: `check: { wcag, failOn, ignore (rule IDs, trailing * for prefixes such as "axe/*"), headless }`.
Exit codes: `0` clean, `1` problems at or above `failOn`, `2` usage/config error or missing browser where required, `3` internal error.

## 7. Dev server — `sforge dev [--port 4321] [--open] [--host [addr]] [--drafts]` ✅ (M2)
- Each build goes into a fresh directory under the OS temp dir (never `build.outDir`); the server switches to it atomically and deletes the previous one after a grace period. A failed build (e.g. invalid config) keeps serving the last good one.
- **URL semantics match production** via one pure function, `resolveRequest` (`packages/server/src/resolve.ts`; moved to `@staticforge/server` in M3 so the checker can share it): `/x/` → `x/index.html`; `/x` → 301 `/x/` (or `x.html` with `trailingSlash: never`); unknown → `404.html` with status 404; dot-paths (`.sforge/`) and symlinks escaping the root are never served. The M5 CloudFront function must pass the same table of tests. Byte ranges are supported for video.
- chokidar watches the project (ignoring `build.outDir`, dot-dirs, `node_modules`); changes are debounced (≥ 60ms, longer than chokidar's 50ms per-file throttle, so a quick second save is never lost); config changes reload the config.
- Live reload over SSE (`/__sforge/events`): the client (`packages/dev-server/client/live-client.js`) reloads, or hot-swaps stylesheets when only CSS changed, and shows an accessible overlay of the current page's errors/warnings: build diagnostics plus the checker's static rules (run after every build).
- `sforge preview [--port 4322] [--dir]` serves an existing build with the same semantics, without the client.
- Both listen on 127.0.0.1 by default; `--host` without a value binds 0.0.0.0 with a warning. Under `--json` they write the envelope when ready, then run until SIGINT/SIGTERM (exit 0).

## 8a. IaC layer (`providers/iac`)
- **Split of responsibilities**: OpenTofu/Terraform owns *infrastructure* (buckets, distribution, functions, certs, DNS, SWA resource, CI identities). The TypeScript SDK deployers own *runtime operations* (content upload, KeyValueStore version switch, rollback, PR previews), because those change on every deploy and would churn state.
- **Engine resolution**: `iac.engine: 'tofu' | 'terraform'` (default `tofu`). Use the binary from PATH if its version is within the supported range. Otherwise download the pinned OpenTofu release and verify its checksum. `iac.version` overrides the pin.
- **Workspace generation**: for each target, sforge writes `.sforge/iac/<target>/` containing `main.tf` (a `module` block that sources the packaged module by absolute path, or a copied vendored module when `iac.vendor: true` for auditability), `backend.tf`, `terraform.tfvars.json` (generated from validated config) and `.terraform.lock.hcl` (committed for provider pinning). Users can also run `tofu` in that directory directly.
- **Remote state, in each target's own cloud**:
  - `sforge provision <target> --bootstrap-state` applies a small `state-bootstrap` module with *local* state. It then migrates (`init -migrate-state`) into the backend it created.
  - **AWS**: S3 bucket `sforge-state-<accountId>-<region>` with BPA on, versioning, SSE (KMS optional), TLS-only policy and **S3 native locking** (`use_lockfile = true`, no DynamoDB table). Key `<site>/<target>.tfstate`.
  - **Azure**: resource group, plus a Storage Account with no public blob access, TLS 1.2, versioning and soft delete, plus container `tfstate`. Blob lease locking; Entra (`use_azuread_auth`) authentication instead of access keys.
  - `--local-state` opts out (experiments only; refused when `CI=true` unless `--force-local-state`).
  - The OIDC CI roles get read/write on their own state key only, so CI can run `provision` too.
- **Commands map**: `provision --diff` → `plan -detailed-exitcode` (rendered as a summary and as JSON with `--json`); `provision` → `plan -out` + `apply <plan>` (asks for confirmation unless `--yes`); `destroy` → `destroy` (needs `--confirm <target>`). After apply, `output -json` is cached to `.sforge/state/<target>.json` (non-secret IDs only) for the deployers.
- **Drift**: `sforge status <target>` runs `plan -refresh-only` and reports drift.
- **Escape hatch**: `iac.extraModules` / an `infra/<target>/*.tf` directory is merged into the workspace, so users can add e.g. WAF or logging tweaks without forking.

## 8. Provider abstraction (`providers/provider-api`)
```ts
interface Provider {
  id: 'aws' | 'azure';
  provision(target, opts): Promise<ProvisionResult>;     // idempotent
  status(target): Promise<TargetStatus>;                  // infra + current version + URL
  deploy(target, buildDir, manifest, opts): Promise<DeployResult>;  // {versionId, url, uploaded, skipped, deleted}
  listVersions(target): Promise<Version[]>;
  rollback(target, versionId?): Promise<DeployResult>;
  preview?(target, prId, buildDir): Promise<DeployResult>;
  destroyPreview?(target, prId): Promise<void>;
  destroy(target, { confirm }): Promise<void>;
}
```
Shared behavior: manifest diffing, cache-header classes (hashed assets → `public, max-age=31536000, immutable`; HTML/feeds/sitemap → `public, max-age=0, must-revalidate`), content-type mapping, concurrency-limited uploads with retries, and `--dry-run` that prints the plan.

## 9. AWS provider (`providers/aws`)
**Provisioning** (`sforge provision staging`): HCL module `aws/terraform/modules/site` (provider `hashicorp/aws` ≥ 5.x, plus an aliased `aws.us_east_1` provider for ACM), applied via the IaC layer (§8a). Resources:
- **S3 bucket**: Block Public Access (all four), `BucketOwnerEnforced`, SSE-S3 (or SSE-KMS option), versioning on, `enforceSSL`, lifecycle rule to expire noncurrent versions and old deploy prefixes beyond `retainVersions`. **No website hosting endpoint.**
- **CloudFront distribution** with **Origin Access Control** (SigV4) and a bucket policy that allows only `cloudfront.amazonaws.com` with `aws:SourceArn` = this distribution. HTTP→HTTPS redirect, HTTP/2+3, TLS 1.2_2021, compression, `CachingOptimized` for assets, a custom cache policy for HTML, a **Response Headers Policy** (HSTS, CSP from config, X-Content-Type-Options, Referrer-Policy, Permissions-Policy), custom error response 404 → `/404.html`.
- **CloudFront KeyValueStore + CloudFront Function (viewer-request)**:
  - Rewrites `/about/` → `/about/index.html` (OAC with the S3 REST origin does not resolve directory indexes).
  - Prefixes the URI with the **active version** read from KVS (`/v/<versionId>/...`). Deploys and rollbacks become an **atomic KVS key update** that propagates in seconds, with no distribution update and no invalidation of HTML across versions.
  - For PR previews, maps `Host: pr-<n>.<previewDomain>` → `pr-<n>` version key.
  - Terraform resources: `aws_cloudfront_key_value_store`, `aws_cloudfront_function` (`cloudfront-js-2.0`, with `key_value_store_associations`). The initial `active` key is seeded with `aws_cloudfrontkeyvaluestore_key` using `lifecycle { ignore_changes = [value] }`, so later deploys (SDK `PutKey`) never cause drift.
- **Optional custom domain**: ACM certificate in **us-east-1** (aliased provider), DNS validation (`aws_acm_certificate_validation`). When `hostedZone` is set, Route 53 alias A/AAAA records are added (plus a wildcard `*.preview.<domain>` for PR previews). Otherwise the required CNAMEs are printed and provisioning waits/polls for validation (`--no-wait` option).
- Optional access logs bucket (`logging: true`) and optional WAF web ACL ARN attachment.
- **GitHub OIDC deploy role** (target key `ci: { repo: 'org/repo', branches: ['main'], environments: [], pullRequests: true }`, shared by both providers): IAM OIDC provider (reused if one exists) plus a least-privilege role (S3 Put/Delete/List on the bucket, `cloudfront-keyvaluestore:PutKey/DescribeKeyValueStore`, `cloudfront:CreateInvalidation` on the distribution). The trust policy is pinned to `repo:org/repo:ref:refs/heads/main` and `environment:` claims.
- Module outputs (bucket, distributionId, kvsArn, domain, ciRoleArn) are cached in `.sforge/state/<target>.json` (non-secret).
- Bucket objects under `v/` are **not** managed by Terraform. The lifecycle rule and the deployer manage them, and `force_destroy` is only set during `sforge destroy`.

**Deploy** (`sforge deploy staging`):
1. `versionId = <utc-timestamp>-<gitShortSha>`.
2. Upload `dist/` to `s3://bucket/v/<versionId>/`. Hashed assets that already exist in the previous version are copied server-side with `CopyObject` instead of re-uploaded.
3. Run a smoke check: fetch `/v/<versionId>/index.html` via S3 HEAD (and optionally a CloudFront canary through a preview host).
4. `PutKey active=<versionId>` in KVS → live.
5. Record the version in `s3://bucket/_sforge/versions.json`. Prune versions beyond `retainVersions`.
6. Invalidation is normally unnecessary (paths are versioned at the origin, but cache keys are viewer URIs). **So:** HTML has max-age=0/must-revalidate and short CloudFront TTL. An optional `--invalidate` issues `/*` invalidation for strictness.

**Rollback**: `sforge rollback staging [--to <versionId>]` sets the KVS key back. `sforge versions staging` lists versions.
**Previews**: `sforge deploy staging --preview pr-42` uploads to `v/pr-42/` and sets KVS `host:pr-42.preview.example.com`. This needs a custom domain; without one, AWS previews are not available and the command errors with an explanation. `sforge preview-destroy staging pr-42`.

## 10. Azure provider (`providers/azure`)
**Provisioning**: HCL module `azure/terraform/modules/site` (`hashicorp/azurerm` 4.x): `azurerm_resource_group` (optional/existing), `azurerm_static_web_app` (Free/Standard, no repo linkage, `preview_environments_enabled`), `azurerm_static_web_app_custom_domain` (cname-delegation or dns-txt-token validation; outputs the validation record to print). An optional `azurerm_dns_cname_record` is added if an Azure DNS zone is given. Writes a generated **`staticwebapp.config.json`** into the build: `navigationFallback` off, `responseOverrides` 404 → `/404.html`, `globalHeaders` (same security headers as AWS), route-level cache headers matching the cache classes, `trailingSlash` setting.
**CI identity**: module `ci-oidc` (`hashicorp/azuread` + `azurerm`): `azuread_application` + service principal + `azuread_application_federated_identity_credential` for `repo:org/repo:environment:<env>` (and `pull_request`), `azurerm_role_assignment` scoped to the SWA resource and the state container. The module is skipped with a clear message (plus the equivalent `az` commands) if the caller lacks Graph permissions, or when the target has no `ci` block.
**Deploy**: fetch the deployment token (`listStaticSiteSecrets`) at runtime using the OIDC/Azure credential (never stored), then upload `dist/` via the SWA deployment client (`@azure/static-web-apps-cli` `deploy` with `--app-location dist --env production`, skip-build).
**Previews**: `--preview pr-42` → SWA named environment `pr-42` (native). `preview-destroy` deletes the environment build.
**Rollback**: SWA has no native version switch, so the tool keeps the last N build archives (`dist` tarballs) in a configured storage container *or* rebuilds from a git ref (`sforge rollback prod --to <gitSha>` checks out the ref into a temp worktree, builds and deploys). This is documented as slower than AWS.

## 11. CLI surface (`packages/cli`)
```
sforge init [dir] [--theme default] [--provider aws|azure] [--yes]   # scaffold project
sforge new page|post <path> [--title]                                 # create content with front-matter
sforge build [--drafts] [--out dist] [--base-url] [--json]
sforge dev [--port] [--open] [--host [addr]] [--drafts]
sforge preview [--port] [--open] [--host [addr]] [--dir]               # serve dist/
sforge check [--fix] [--dry-run] [--headless|--no-headless] [--pages glob] [--format pretty|json|sarif|junit]
sforge provision <target> [--diff] [--bootstrap-state] [--local-state] [--no-wait] [--yes]
sforge iac path|init|plan|apply|output <target>                      # low-level access to the generated tofu/terraform workspace
sforge deploy <target> [--preview <id>] [--no-build] [--no-check] [--invalidate] [--dry-run] [--yes]
sforge versions <target>
sforge rollback <target> [--to <versionId|gitSha>] [--yes]
sforge preview-destroy <target> <id>
sforge status <target>
sforge destroy <target> --confirm <target-name>
sforge ci init [--targets staging,prod]                              # emit GitHub Actions workflows
sforge theme list|validate <path>
sforge schema config|output|diagnostics                              # print JSON Schemas for agents
sforge config validate|show                                          # validate / print resolved config
sforge version
sforge mcp                                                            # MCP stdio server
```
Global flags: `--json` (one JSON document on stdout, logs on stderr), `--quiet`, `--verbose`, `--cwd`, `--config`, `--no-color`, `--non-interactive` (auto when `CI=true` or no TTY. Destructive operations then require `--yes`/`--confirm`). `deploy` runs `build` + `check` first by default and refuses if the check fails (`--no-check` to override).

## 12. MCP server (`packages/mcp`)
Tools: `sforge_build`, `sforge_check` (args: fix, headless, pages), `sforge_fix_preview` (returns a diff), `sforge_dev_start/stop` (returns the URL), `sforge_deploy` (requires `confirm: true`), `sforge_status`, `sforge_versions`, `sforge_rollback`, `sforge_new_page`, `sforge_config_schema`. Resources: `sforge://config`, `sforge://diagnostics/latest`, `sforge://build-manifest`. Every tool calls the same core functions the CLI uses, so there is no logic duplication. Provision/destroy are **not** exposed by default (`sforge mcp --allow-infra` enables them).

## 13. GitHub Actions (`sforge ci init`)
Generates `.github/workflows/`:
- **`site.yml`**: on `pull_request` → install, `sforge build`, `sforge check --headless --format sarif` (uploaded to code scanning, plus PR annotations), `sforge deploy <target> --preview pr-${{ github.event.number }}`, then a comment with the preview URL. On `push` to `main` → build, check, `deploy staging`. A `workflow_dispatch`/release with a `prod` **environment** (protection rules) → `deploy prod`.
- **`preview-cleanup.yml`**: on `pull_request: closed` → `sforge preview-destroy`.
- Auth: `aws-actions/configure-aws-credentials` with `role-to-assume` (from provision output) and `permissions: id-token: write`. `azure/login` with federated client-id/tenant/subscription. Pinned action SHAs, Playwright browser caching, pnpm/npm cache.

## 14. Security and quality
- No secrets in config or state files. Credentials come from standard SDK chains (AWS profile/SSO/OIDC; `DefaultAzureCredential`).
- The CSP defaults to `script-src 'self'`. Inline scripts emitted by the theme use hashes computed at build time and added to the CSP.
- Path traversal guarded in the dev server and in output writes. Content is sanitized only for user-flagged untrusted HTML (opt-in `rehype-sanitize`), since authors own their content.
- Tests: unit tests per package; golden-output snapshots for `examples/basic-site`; checker rule fixtures (bad/good/fixed HTML trios); AWS deployer against `aws-sdk-client-mock`; HCL modules checked with `tofu validate`, `tflint`, `checkov`, and `tofu test` (mock providers) asserting bucket BPA on, no website config, OAC present, bucket policy SourceArn = distribution, TLS-only, HTTPS redirect; the IaC runner unit-tested with a fake engine binary that emits recorded `-json` streams; Azure deployer with mocked clients; e2e Playwright against `sforge preview`; an optional live integration job (manual) that provisions → deploys → curls → rolls back → destroys in a sandbox account/subscription.

## 15. Milestones
0. **Step 0** ✅: this plan is kept in `PLAN.md` as the project's living design document. Update it when decisions change.
1. **M0 Scaffold** ✅: monorepo, tooling, CI for the repo itself, `core` config + logger + error codes, `cli` skeleton with `--json`/exit codes, `config validate|show`, `schema config|output`, `version`.
2. **M1 Build** ✅: markdown pipeline, HTML detection/wrapping, link resolution, Nunjucks render, default theme (+ `templates/` overrides, `data/`), static/assets copy, build manifest, basic top-level nav, `sforge build`, `init` (non-interactive; `--format ts|json|yaml`), `new page|post`, `examples/basic-site`, docs/content.md + docs/themes.md.
3. **M2 Preview** ✅: `dev` (watch + SSE live reload + CSS hot-swap + problems overlay) and `preview`, production-equivalent request resolution, per-run isolated test temp dirs.
4. **M3 Checker** ✅: `@staticforge/checker` (source/output/rendered layers with de-duplication, html-validate, axe-core via playwright-core in light/dark/mobile), source autofixes with `--dry-run` diffs, pretty/json/sarif/junit reporters, `sforge check`, `schema diagnostics`, checker results in the dev overlay, `@staticforge/server` split out, GFM task-list labels, Node floor raised to 22.22/24.8, Vitest resolving workspace packages to sources (`ssr.resolve.conditions`; tests previously loaded sibling packages' `dist/`), Chromium installed in CI.
5. **M4 Site features + assets**: nav/breadcrumbs, sitemap/robots/404, collections/tags/pagination/RSS/Atom, sharp images, esbuild/lightningcss, fingerprinting, Pagefind.
6. **M5a IaC layer**: engine resolver/downloader (tofu default, terraform optional), workspace generator, runner with `-json` parsing, state bootstrap modules (S3 native lock / Azure blob), `provision --diff`, `status` drift, `iac` passthrough.
7. **M5b AWS**: HCL modules (S3 + OAC + CloudFront + KVS function + headers + optional ACM/Route 53 + OIDC role), SDK deployer, versions/rollback, previews.
8. **M6 Azure**: HCL modules (SWA + custom domain + azuread OIDC), `staticwebapp.config.json` generation, SDK deploy, preview envs, rollback-by-rebuild.
9. **M7 CI/CD + MCP**: `ci init` workflows, MCP server, JSON schemas, docs.
10. **M8 Hardening**: live integration tests, performance (parallel rendering via worker threads; incremental dev rebuilds and checking only affected pages), a browser test of the live-reload client, docs site built *with* sforge (dogfooding), npm publish.

## 16. Verification (end to end)
1. `pnpm -r test` (unit + snapshot + checker fixtures) plus `tofu test` for the HCL modules and `pnpm -r typecheck`.
2. `cd examples/basic-site && sforge build && sforge check --headless --json`: expect zero errors. Introduce known defects (missing alt, skipped heading, no lang) → expect the matching diagnostics; `sforge check --fix` → re-check shows the fixable ones resolved and alt text still reported.
3. `sforge dev`: edit markdown → the browser reloads; Playwright e2e checks the nav, search and skip link via keyboard.
4. AWS sandbox: `sforge provision staging --bootstrap-state` → state is in the S3 backend with a lockfile; `provision --diff` immediately after shows no changes; deploying twice still shows no drift (KVS key ignored). Verify the S3 bucket is **not** publicly reachable (`curl https://<bucket>.s3.amazonaws.com/v/.../index.html` → 403) while CloudFront serves the site; `deploy` twice → `versions` shows 2; `rollback` → content switches in seconds; `/about/` resolves; the 404 page is served; security headers are present.
5. Azure sandbox: `provision prod` → `deploy prod` → URL serves the site with headers from `staticwebapp.config.json`; `--preview pr-1` creates a named environment; `preview-destroy` removes it.
6. GitHub: open a PR in a test repo → workflow builds, checks (SARIF annotations), deploys the preview and comments the URL; merge → deploys staging; close → preview cleaned up.
7. MCP: run `sforge mcp` with Claude Code, call `sforge_check` and `sforge_build`, and verify structured results.
