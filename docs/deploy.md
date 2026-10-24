# Provisioning and deploying

`sforge` separates two kinds of work:

- **Infrastructure** (buckets, the CDN, certificates, DNS, CI identities) is created by
  `sforge provision` with packaged HCL modules, run by **OpenTofu** (default) or
  **Terraform**. It changes rarely.
- **Content** is uploaded by `sforge deploy` with the cloud SDK. Every deploy is a new
  version; switching versions (deploy, rollback) takes seconds.

AWS and Azure Static Web Apps targets are available. The sections below describe AWS unless they
say otherwise; [Azure Static Web Apps](#azure-static-web-apps) lists what differs.

> Custom domains, PR previews (which need a custom domain on AWS) and the GitHub Actions deploy
> role are implemented for AWS and covered by the module tests, but have not been verified
> against a real account yet. That, the Azure equivalents and `sforge ci init` are milestone M9.

## Quick start (AWS)

```ts
// staticforge.config.ts
export default defineConfig({
  site: { title: 'Docs', baseUrl: 'https://docs.example.com' },
  targets: {
    staging: { provider: 'aws', region: 'eu-central-1' },
  },
});
```

```sh
aws sso login                                  # any credential the AWS SDK finds works
sforge provision staging --bootstrap-state     # once: state bucket, then the site
sforge deploy staging                          # build, check, upload, go live
sforge versions staging
sforge rollback staging                        # back to the previous version
```

`sforge provision staging --diff` shows what would change without changing anything.
`sforge status staging` shows the URL and active version, and exits 1 if the infrastructure
changed outside OpenTofu/Terraform (drift).

## The engine: OpenTofu or Terraform

`iac.engine` selects `tofu` (default) or `terraform`.

- **OpenTofu**: a `tofu` on PATH is used if it is 1.10 or later (and equals `iac.version` when
  that is set). Otherwise sforge downloads OpenTofu 1.13.1 from GitHub into
  `~/.cache/staticforge/bin/` and verifies its SHA-256 against checksums built into sforge. With
  `iac.version` set to another release, the checksum comes from that release's `SHA256SUMS`
  file, which catches corrupted downloads but not a compromised release.
- **Terraform** 1.10 or later must be on PATH; sforge never downloads it.
- `SFORGE_TOFU_PATH` / `SFORGE_TERRAFORM_PATH` select a binary explicitly.
  `SFORGE_CACHE_DIR` moves the cache. Providers are cached in
  `~/.cache/staticforge/plugins/`.

## The workspace

For each target, sforge writes a root workspace to `.sforge/iac/<target>/` before every run:

| File                    | Contents                                                                   |
| ----------------------- | -------------------------------------------------------------------------- |
| `main.tf.json`          | Providers, the packaged module (with every input from a variable), outputs |
| `backend.tf.json`       | The remote state backend                                                   |
| `terraform.tfvars.json` | The module inputs, derived from the validated config                       |
| `.terraform.lock.hcl`   | Provider checksums for Linux, macOS and Windows. **Commit it.**            |
| `infra_*.tf`            | Copies of your own files from `infra/<target>/` (see below)                |

The workspace's own `.gitignore` excludes `.terraform/`, plans, local state and (unless
`iac.vendor` is set) `main.tf.json`, which holds a machine-specific path to the module.
With `iac.vendor: true` the module is copied into `modules/` for review and can be committed.

- **Your own HCL**: put `.tf` files in `infra/<target>/` (for example a WAF rule or extra
  logging). They are merged into the workspace and can reference `module.site`.
- **Direct access**: `sforge iac path staging` prints the workspace;
  `sforge iac plan|apply|output|state|import|validate|show|console staging -- <args>` runs the
  engine there (engine output goes to stderr under `--json`). You can also `cd` into the
  workspace and run `tofu` yourself.

## Remote state

State is kept in the target's own cloud. `--bootstrap-state` creates the backend once:

- **AWS**: S3 bucket `sforge-state-<accountId>-<region>` (or `targets.<name>.state.bucket`)
  with Block Public Access, versioning, encryption (SSE-S3, or SSE-KMS with `state.kmsKeyArn`)
  and a TLS-only policy. Locking uses S3 native lock files (`use_lockfile`); no DynamoDB table.
  The key is `<project>/<target>.tfstate`, where `<project>` is `iac.name` or the host of
  `site.baseUrl` (`docs-example-com`).
- The bootstrap module is applied with local state, which is then migrated into the bucket it
  created (`_sforge/state-bootstrap.tfstate`). An existing bucket is never modified, so the
  flag is safe to repeat. sforge never deletes the state bucket.

`--local-state` keeps state in the workspace instead. It is meant for experiments and is
refused when `CI` is set, unless `--force-local-state` is also given.

## What gets created on AWS

The `site` module (`packages/providers/aws/terraform/modules/site`):

- A **private S3 bucket**: Block Public Access on, ACLs disabled, versioning, SSE-S3, TLS-only.
  There is no website endpoint; only the distribution can read it, through **Origin Access
  Control** (the bucket policy checks `AWS:SourceArn`).
- A **CloudFront distribution**: HTTPS only (HTTP redirects), HTTP/2 and HTTP/3, compression,
  a cache policy that honours each object's `Cache-Control`, and a **response headers policy**
  with the `security` headers (below). Missing pages get the site's `404.html` with status 404.
- A **CloudFront Function** (viewer request) and a **KeyValueStore**, which together route
  URLs and versions (see below).
- With `domain`: an ACM certificate in us-east-1 (CloudFront requires it there) and TLS 1.2 or
  later. With `hostedZone`, Route 53 validates the certificate and gets A/AAAA alias records.
  Without one, `provision` creates the certificate first, prints the DNS validation records,
  and waits (up to 2 hours) until they resolve; `--no-wait` stops after printing them. After
  provisioning, point the domain at the distribution with the printed CNAME.
- With `previewDomain` (requires `domain`): a wildcard certificate and aliases for
  `*.<previewDomain>`, for PR previews.
- With `logging: true`: a log bucket for CloudFront standard logs (kept 90 days).
- With `wafWebAclArn`: the web ACL is attached to the distribution.
- With `ci`: a GitHub Actions deploy role (below).

## Versions, routing and rollback

A deploy uploads the build to `v/<versionId>/` in the bucket, where `versionId` is
`<UTC time>-<git sha>`, for example `20261024T173405Z-6ffcbe4`. Files identical to the previous
version are copied inside S3 instead of uploaded. Every upload carries its SHA-256, so S3 rejects
corrupted files. Then the KeyValueStore key `active` is switched to the new version. The router
function reads it on every request, so a deploy or rollback goes live within seconds, without
updating the distribution.

The router rewrites the URL before CloudFront looks in its cache, so the cache key includes the
version. A new version is never served from stale cache, and invalidations are unnecessary
(`--invalidate` exists for extra caution). Fingerprinted assets are cached for a year
(`immutable`); everything else revalidates with its ETag on every request.

URLs are mapped exactly like `sforge preview` does it locally: `/about/` → `about/index.html`,
`/about` → 301 `/about/` (or `about.html` with `trailingSlash: "never"`), dot-paths never served.
Pages that break the rule for their mode (a section index with `trailingSlash: "never"`, a file
without an extension) are stored as route exceptions in the KeyValueStore at deploy time. One
difference remains: for a URL that does not exist at all, CloudFront may answer with a redirect
followed by the 404 page, where the local server answers 404 directly.

`sforge deploy` keeps `retainVersions` (default 10) production versions and deletes older ones.
`sforge rollback <target>` serves the version before the active one; `--to <versionId>` picks
one from `sforge versions`. Concurrent deploys to the same target are detected: the second
one fails and asks you to deploy again.

Bookkeeping lives in the bucket under `_sforge/` (`versions.json`, a manifest per version and
the current 404 page). The router never serves it.

## Deploying

```sh
sforge deploy staging               # build + check + upload + switch
sforge deploy staging --dry-run     # what would be uploaded
sforge deploy staging --no-check    # deploy even if the check finds errors
sforge deploy staging --no-build    # deploy the existing build in build.outDir
```

By default `deploy` builds into `build.outDir`, runs the checker (rendered checks too, unless
`--no-headless` or `check.headless: false`), and refuses to deploy (`SF_CHECK_FAILED`, exit 1)
if it finds problems at or above `check.failOn`.

The deployer needs the infrastructure's outputs (bucket, distribution, KeyValueStore). After
`provision` they are cached in `.sforge/state/<target>.json`. The file is not committed, so
in CI `deploy` reads them from the remote state with the engine.

## PR previews

With `domain` and `previewDomain` set (for example `previewDomain: "preview.example.com"`):

```sh
sforge deploy staging --preview pr-42   # → https://pr-42.preview.example.com
sforge preview-destroy staging pr-42
```

A preview gets its own canonical URLs (the build uses the preview URL as `site.baseUrl`) and is
overwritten in place by later deploys with the same id. Without a custom domain, AWS targets
cannot serve previews and `--preview` fails with `SF_UNSUPPORTED`. Previews share production's
404 page.

## Security headers

Sent with every response (configure with `security` in the config):

| Header                      | Default                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `Content-Security-Policy`   | `default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data: https:; …` |
| `Strict-Transport-Security` | `max-age=63072000` (`security.hsts`: `includeSubDomains`, `preload`, or `false`)                                          |
| `X-Content-Type-Options`    | `nosniff`                                                                                                                 |
| `X-Frame-Options`           | `SAMEORIGIN` (`security.frameOptions`)                                                                                    |
| `Referrer-Policy`           | `strict-origin-when-cross-origin` (`security.referrerPolicy`)                                                             |
| `Permissions-Policy`        | `camera=(), microphone=(), geolocation=(), payment=(), usb=()`                                                            |

The search page and Pagefind's files (`/pagefind/*`, whose Web Worker compiles WebAssembly)
also get `'wasm-unsafe-eval'` in `script-src`. Inline style attributes are allowed for code highlighting; inline scripts are not.
Set `security.contentSecurityPolicy` to your own policy, or `false` to send none.

## GitHub Actions (OIDC)

```ts
targets: {
  staging: {
    provider: 'aws',
    region: 'eu-central-1',
    ci: { repo: 'acme/docs', branches: ['main'], environments: ['staging'], pullRequests: true },
  },
},
```

`provision` then creates an IAM role that GitHub Actions can assume through OIDC, so no
long-lived keys are needed. Its ARN is printed and kept in the `ci_role_arn` output. The trust
policy accepts only that repository's listed branches, environments and (if enabled) pull
request workflows. The role can write the content bucket, switch versions in the
KeyValueStore, invalidate the distribution, and read and write this target's own state file.
It cannot change the infrastructure, so run `provision` with an administrator's credentials.
The account's GitHub OIDC provider is reused if one exists; otherwise it is created and owned
by this target. `sforge ci init` (milestone M9) will generate the workflows.

## Azure Static Web Apps

```ts
// staticforge.config.ts
export default defineConfig({
  site: { title: 'Docs', baseUrl: 'https://docs.example.com' },
  targets: {
    prod: { provider: 'azure', resourceGroup: 'rg-docs', location: 'westeurope' },
  },
});
```

```sh
az login                                       # anything DefaultAzureCredential finds works
sforge provision prod --bootstrap-state        # once: state storage, then the site
sforge deploy prod
sforge versions prod
sforge deploy prod --preview pr-42             # a named preview environment
sforge preview-destroy prod pr-42
sforge rollback prod                           # rebuilds the previous version's commit
```

> **Regions**: Azure can refuse new resources in a region for a given subscription
> (`RequestDisallowedByAzure … region is not accepting new customers`). That happened in
> West Europe for both Storage and Static Web Apps on a new pay-as-you-go subscription, so
> the example site was verified in `eastus2`. Static Web Apps only exist in five regions, and the
> state storage can live elsewhere: set `state.location` (e.g. `northeurope`) if it is refused.
> The content is served from Azure's global edge either way.

**Prerequisites**: an Azure subscription (sforge uses `targets.<name>.subscriptionId`, else
`AZURE_SUBSCRIPTION_ID` / `ARM_SUBSCRIPTION_ID`, else the one `az login` selected), the Azure CLI
for `az login`, and Owner (or Contributor plus User Access Administrator) on the subscription for
`--bootstrap-state`. sforge registers the `Microsoft.Web` and `Microsoft.Storage` resource
providers itself.

**Target options**: `resourceGroup` (created and deleted with the site unless
`createResourceGroup: false`), `location` (`westus2`, `centralus`, `eastus2`, `westeurope` or
`eastasia`: the only regions with Static Web Apps), `sku` (`Free` or `Standard`),
`retainVersions` (deploys remembered for rollback, default 10) and `state`. `domain`, `dnsZone` and
`ci` are rejected for now (`SF_UNSUPPORTED`): custom domains and the GitHub Actions identity are
milestone M9, so the site is served at its `*.azurestaticapps.net` URL. Set `site.baseUrl` to
that URL (printed by `provision`) so canonical links and the sitemap are right.

### Remote state

`--bootstrap-state` creates, once per subscription, resource group `sforge-state` with a storage
account `sfstate<hash of the subscription>` and a private `tfstate` container (names and the
region can be set with `targets.<name>.state`). The account has no public blob access, TLS 1.2 only, **account keys
disabled** (state is read and written with Microsoft Entra ID), blob versioning and 30 days of soft
delete. Locking uses blob leases. State is kept at `<project>/<target>.tfstate`.

Subscription **Owner does not include access to blob data**, so the bootstrap also grants
`Storage Blob Data Contributor` on the account to the identity that runs it, and waits two minutes
for the role assignment to take effect before migrating its own state into the account. Other
people (and, from M9, CI) need the same role. If `provision` fails with
`AuthorizationPermissionMismatch` or a 403 on the state blob, the role is missing or has not
propagated yet.

### What gets created

The `site` module (`packages/providers/azure/terraform/modules/site`): the resource group and an
`azurerm_static_web_app` with named preview environments enabled and no repository link. The
deployment token is read by `sforge deploy` when needed; it is neither an output nor written to any
file.

### Deploying, versions and rollback

`sforge deploy prod` copies the publishable files of the build (never `.sforge/`) and a generated
`staticwebapp.config.json` to a temporary directory, uploads it with the `swa` deployment client
(`@azure/static-web-apps-cli`, which downloads Microsoft's `StaticSitesClient` on first use), and
waits until Azure reports the environment ready. The generated file carries:

- the `security` headers on every response (and the WebAssembly CSP on the search page and
  `/pagefind/*`),
- `trailingSlash` from `build.trailingSlash` (Static Web Apps redirects `/about` to `/about/` itself;
  `always` becomes SWA's `auto`, because SWA's own `always` would also redirect `style.css` to `style.css/`),
- `404.html` as the not-found page (status 404),
- one-year `immutable` caching for fingerprinted files, as one rule per directory that holds only
  fingerprinted files and per file otherwise. Static Web Apps limits the file to 20 KB: if there
  are too many files, the rest is cut off with a warning and those files revalidate instead,
- content types for formats Static Web Apps may not know (`.avif`, `.webp`, `.vtt`, …).

A `static/staticwebapp.config.json` of your own replaces the generated file (with a warning).

Static Web Apps has no version switch, so sforge keeps the history itself: each production deploy
is recorded (version id `<UTC time>-<git sha>`, files, size) in the state container at
`_sforge/<project>/<target>/versions.json`, written with ETags so concurrent deploys do not lose
entries. `sforge rollback prod [--to <versionId|gitSha>]` **rebuilds** the commit of the chosen
version in a temporary git worktree (with that commit's own config and content; your
`node_modules` and image cache are shared) and deploys it as a new version marked `rollbackOf`.
That takes as long as a build plus a deploy, not the seconds of AWS. It needs the commit in the
repository (in CI, `fetch-depth: 0`), and versions deployed with uncommitted changes cannot be
rolled back to.

### Previews

`sforge deploy prod --preview pr-42` deploys to a Static Web Apps **named environment** (no custom
domain needed) and builds it with that environment's URL as `site.baseUrl`. Azure keeps only
lowercase letters and digits in the name, so `pr-42` is served at
`https://<app>-pr42.<region>.<n>.azurestaticapps.net`, `sforge versions` lists it as `pr42`, and
`pr-42` and `pr42` are the same environment. The Free plan allows 3
preview environments (Standard 10): remove finished ones with `sforge preview-destroy prod pr-42`.

### Limits

Free plan: 250 MB per environment, 500 MB per app, 15,000 files, 100 GB bandwidth per month.
`deploy` refuses sites over the Free limits before uploading.

### Destroying

`sforge destroy prod --confirm prod` removes the Static Web App (and its resource group, if sforge
created it). The state storage account and its history are kept.

## Destroying (AWS)

```sh
sforge destroy staging --confirm staging
```

Removes every resource of the target, including all deployed versions. The state bucket and its
state file history are kept.

## Credentials and errors

AWS credentials come from the SDK's default chain (`AWS_PROFILE`, SSO, environment, OIDC in CI),
both for sforge and for the engine. Azure credentials come from `DefaultAzureCredential` (`az login`,
environment variables, managed identity, workload identity) for sforge, and the engine uses the
Azure CLI login or the `ARM_*` variables. Missing or expired credentials, and missing permissions,
fail with `SF_CLOUD_AUTH`.
Other error codes: `SF_ENGINE_MISSING`, `SF_STATE_MISSING`, `SF_NOT_PROVISIONED`,
`SF_IAC_FAILED` (with the engine's diagnostics in `details`), `SF_CONFIRMATION_REQUIRED`
(non-interactive runs need `--yes`), `SF_DEPLOY_FAILED`, `SF_VERSION_NOT_FOUND`,
`SF_UNSUPPORTED`.

## Testing the modules

```sh
cd packages/providers/aws/terraform/modules/site      # or packages/providers/azure/terraform/...
tofu init -backend=false && tofu test     # mocked cloud: no account needed
pnpm test:iac                             # validate the generated workspaces with tofu/terraform
```
