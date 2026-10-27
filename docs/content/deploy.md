# Provisioning and deploying

`sforge` separates two kinds of work:

- **Infrastructure** (buckets, the CDN, certificates, DNS, CI identities) is created by
  `sforge provision` with packaged HCL modules, run by **OpenTofu** (default) or
  **Terraform**. It changes rarely.
- **Content** is uploaded by `sforge deploy` with the cloud SDK. Every deploy is a new
  version; switching versions (deploy, rollback) takes seconds to a few minutes.

AWS and Azure Static Web Apps targets are available. The sections below describe AWS unless they
say otherwise; [Azure Static Web Apps](#azure-static-web-apps) lists what differs. Targets that
require signing in are described in [Private sites](private-sites.md).

> Custom domains (with records in Cloudflare) and PR previews on AWS are verified against real
> accounts by the live tests. The GitHub Actions identities are covered by the module tests;
> their verification from a real repository is part of milestone M9.

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
  `site.baseUrl` (`docs-example-com`). The project name also prefixes resource names, so set
  `iac.name` when targets have their own domains; changing it later recreates the resources.
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
  With `dns`, the validation records and CNAMEs for the domain (and the preview wildcard) are
  created in Cloudflare in the same apply ([below](#dns-records-in-cloudflare)).
  Without either, `provision` creates the certificate first, prints the DNS validation records,
  and waits (up to 2 hours) until they resolve; `--no-wait` stops after printing them. After
  provisioning, point the domain at the distribution with the printed CNAME.
- With `previewDomain` (requires `domain`): a wildcard certificate and aliases for
  `*.<previewDomain>`, for PR previews.
- With `logging: true`: a log bucket for CloudFront standard logs (kept 90 days).
- With `wafWebAclArn`: the web ACL is attached to the distribution.
- With `ci`: a GitHub Actions deploy role (below).

## DNS records in Cloudflare

When the zone of the custom domain is on Cloudflare, sforge can create and remove its records:

```ts
targets: {
  staging: {
    provider: 'aws',
    region: 'eu-north-1',
    domain: 'docs.example.com',
    previewDomain: 'preview.example.com',
    dns: { provider: 'cloudflare', zone: 'example.com' },
  },
}
```

- Create an API token in the Cloudflare dashboard with **Zone → DNS → Edit** and **Zone → Zone →
  Read** on the zone (the "Edit zone DNS" template plus Zone Read) and export it as
  `CLOUDFLARE_API_TOKEN` where you run `provision`, `status` and `destroy`. sforge never writes it
  to a file. With `dns.zoneId` set, sforge skips the zone lookup and Zone Read is not needed.
  Deploys only read outputs, so CI needs no Cloudflare token.
- The records are **DNS-only**, never proxied: CloudFront terminates TLS with its own
  certificate, and the certificate validation needs the real CNAME targets.
- Each record carries the comment `staticforge <project>/<target>`; `destroy` removes them.
- Do not create the records yourself: a record with the same name makes the apply fail.
- `domain` and `previewDomain` must be inside `zone`, and `dns` cannot be combined with
  `hostedZone`. If the zone has CAA records, they must allow `amazon.com`.

## Versions, routing and rollback

A deploy uploads the build to `v/<versionId>/` in the bucket, where `versionId` is
`<UTC time>-<git sha>`, for example `20261024T173405Z-6ffcbe4`. Files identical to the previous
version are copied inside S3 instead of uploaded. Every upload carries its SHA-256, so S3 rejects
corrupted files. Then the KeyValueStore key `active` is switched to the new version. The router
function reads it on every request, so a deploy or rollback goes live without updating the
distribution: at most edge locations within seconds, at all of them within a few minutes (the
KeyValueStore is eventually consistent; a rollback in the CI test repository took about two
minutes to reach every edge).

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

Production builds use the target's own URL for canonical links, feeds and the sitemap:
`targets.<name>.baseUrl` if set, else `https://<domain>/` when the target has a `domain`, else
`site.baseUrl`. So one project can deploy to several targets on different domains.
`sforge build` on its own always uses `site.baseUrl`.

The deployer needs the infrastructure's outputs (bucket, distribution, KeyValueStore). After
`provision` they are cached in `.sforge/state/<target>.json`. The file is not committed, so
in CI `deploy` reads them from the remote state with the engine.

## PR previews

With `domain` and `previewDomain` set (for example `previewDomain: "preview.example.com"`):

```sh
sforge deploy staging --preview pr-42   # → https://pr-42.preview.example.com
sforge preview-destroy staging pr-42
```

A preview gets its own canonical URLs (the build uses the preview URL as `site.baseUrl`), every
page carries `<meta name="robots" content="noindex">` so that search engines leave previews out,
and it is overwritten in place by later deploys with the same id. Without a custom domain, AWS targets
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
request workflows, in the repository's subject format
([immutable subjects](ci.md#which-workflows-can-deploy) included). The role can write the content bucket, switch versions in the
KeyValueStore, invalidate the distribution, and read and write this target's own state file.
It cannot change the infrastructure, so run `provision` with an administrator's credentials.
The account's GitHub OIDC provider is reused if one exists; otherwise it is created and owned
by this target. [`sforge ci init`](ci.md) writes the workflows that use it.

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
`retainVersions` (deploys remembered for rollback, default 10), `state`, `domain` and `dns`
([custom domain](#custom-domain)), `ci` ([GitHub Actions](#github-actions-identity)) and `baseUrl`.
Without a `domain` the site is served at its `*.azurestaticapps.net` URL: set the target's
`baseUrl` (or `site.baseUrl`) to that URL (printed by `provision`) so canonical links and the
sitemap are right.

### Custom domain

```ts
prod: {
  provider: 'azure',
  resourceGroup: 'rg-docs',
  location: 'eastus2',
  domain: 'azure.docs.example.com',
  dns: { provider: 'cloudflare', zone: 'example.com' }, // optional
},
```

Static Web Apps validates a subdomain through a CNAME to the app's default host, then issues a
free managed certificate. With `dns`, sforge creates that CNAME in Cloudflare (see
[DNS records in Cloudflare](#dns-records-in-cloudflare); the same token and rules apply) before
adding the domain. Without it, `provision` creates the app first, prints the CNAME, and waits (up to
an hour) while Azure validates it; `--no-wait` stops after printing. A domain in a private DNS zone
(`privateDns: true`) is validated with a TXT record instead; see
[Private DNS](private-sites.md#private-dns). Apex domains (`example.com`) are refused with
`SF_UNSUPPORTED`.
The Free plan allows two custom domains per app. PR previews stay on their
`*.azurestaticapps.net` hosts: Static Web Apps has no wildcard domains.

### GitHub Actions identity

With `ci` (the same option as on AWS, e.g.
`ci: { repo: 'acme/docs', environments: ['production'] }`), `provision` also creates (module
`ci-oidc`):

- a Microsoft Entra application and service principal with one **federated login** per branch,
  environment and (if enabled) pull requests of that repository. GitHub's OIDC tokens sign in as
  it; there is no secret. Entra matches subjects exactly and allows 20 per application.
- a custom role on the site's resource group, assigned on the Static Web App only, that can read
  the app, list and delete its environments, and read its deployment token: what `deploy`,
  `rollback` and `preview-destroy` need.
- `Storage Blob Data Contributor` on the state container, with a condition that limits reading,
  writing and deleting to this target's state file and its deploy history. Blob names in the
  container can be listed.

The identity cannot change the infrastructure, so run `provision` as an administrator. The
outputs `ci_client_id`, `ci_tenant_id` and `ci_subscription_id` are what `azure/login` needs.
Creating the application needs permission to register applications in Entra (users have it unless
the tenant restricts it).

### Remote state

`--bootstrap-state` creates, once per subscription, resource group `sforge-state` with a storage
account `sfstate<hash of the subscription>` and a private `tfstate` container (names and the
region can be set with `targets.<name>.state`). The account has no public blob access, TLS 1.2 only, **account keys
disabled** (state is read and written with Microsoft Entra ID), blob versioning and 30 days of soft
delete. Locking uses blob leases. State is kept at `<project>/<target>.tfstate`.

Subscription **Owner does not include access to blob data**, so the bootstrap also grants
`Storage Blob Data Contributor` on the account to the identity that runs it, and waits two minutes
for the role assignment to take effect before migrating its own state into the account. Other
people need the same role; the [GitHub Actions identity](#github-actions-identity) gets a narrower
one. If `provision` fails with
`AuthorizationPermissionMismatch` or a 403 on the state blob, the role is missing or has not
propagated yet.

### What gets created

The `site` module (`packages/providers/azure/terraform/modules/site`): the resource group and an
`azurerm_static_web_app` with named preview environments enabled and no repository link, and the
custom domain when one is set. The
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
fail with `SF_CLOUD_AUTH`, and so does a missing or refused `CLOUDFLARE_API_TOKEN` for targets
with `dns`.
Other error codes: `SF_ENGINE_MISSING`, `SF_STATE_MISSING`, `SF_NOT_PROVISIONED`,
`SF_IAC_FAILED` (with the engine's diagnostics in `details`), `SF_CONFIRMATION_REQUIRED`
(non-interactive runs need `--yes`), `SF_DEPLOY_FAILED`, `SF_VERSION_NOT_FOUND`,
`SF_UNSUPPORTED`, and for `sforge users`, `SF_USER_EXISTS` and `SF_USER_LIMIT`.

## Testing the modules

```sh
cd packages/providers/aws/terraform/modules/site      # or packages/providers/azure/terraform/...
tofu init -backend=false && tofu test     # mocked cloud: no account needed
pnpm test:iac                             # validate the generated workspaces with tofu/terraform
```

## Live tests

`pnpm test:live` runs the whole cycle against a real account: it copies the example site to a
temporary git repository, provisions a target with a remote state backend, checks that a second
plan has no changes, deploys twice, checks the served site over HTTP (status codes, the
trailing-slash redirect, the 404 page, security and cache headers, `.sforge/` not served, and on
AWS that the bucket refuses direct requests), checks for drift, rolls back, and on Azure deploys
and removes a preview environment. It always destroys the target at the end (the state backend
is kept and reused); if that fails, it prints the command to clean up.

It signs in the way the CLI does (your AWS profile or SSO session, or `az login`) and asks you to
name the account it will touch:

```sh
SFORGE_LIVE=aws SFORGE_LIVE_CONFIRM=<account id> pnpm test:live          # eu-north-1, or SFORGE_LIVE_REGION
SFORGE_LIVE=azure SFORGE_LIVE_CONFIRM=<subscription id> pnpm test:live   # eastus2, state in northeurope
```

Provisioning CloudFront takes several minutes, so an AWS run takes about 10–20 minutes. Run it
in a sandbox account or subscription.

To test custom domains too, name a parent domain in a Cloudflare zone; the token is the one
`dns` uses ([DNS records in Cloudflare](#dns-records-in-cloudflare)):

```sh
SFORGE_LIVE_DOMAIN=aws.sforge.example.com SFORGE_LIVE_DNS_ZONE=example.com \
  SFORGE_LIVE=aws SFORGE_LIVE_CONFIRM=<account id> pnpm test:live
```

The target then gets the domain `t-<run id>.<parent>` (and on AWS previews on
`*.p-<run id>.<parent>`), so runs never collide with each other or with a site on the parent
itself. The test checks that the records are created, that the site is served over HTTPS on the
domain with a valid certificate and canonical URLs on it, on AWS that a preview is served on
`pr-1.p-<run id>.<parent>` and removed, and after `destroy` that no record with the run id is
left. Allow 30–60 minutes: certificates and, on Azure, domain validation take a while.

With `SFORGE_LIVE_AUTH=1`, the run tests a [private site](private-sites.md) instead. It checks
that every URL sends anonymous visitors to sign in. On AWS it then creates a throwaway Cognito
user (no email is sent), signs in through the managed login in headless Chromium, loads pages,
assets and (with a domain) a preview through the handoff, signs out, and checks that
`sforge users revoke-sessions` ends the session. On Azure, signing in needs a real Microsoft or
GitHub account: the run prints an invitation link, and `SFORGE_LIVE_KEEP=1` leaves the site up for
a manual check (it prints the `destroy` command to run afterwards).

`SFORGE_LIVE_PRIVATE_DNS=1` (with `SFORGE_LIVE_DOMAIN`) adds `privateDns`: the run checks that
only validation records are published, and reaches the domain through the CloudFront or Static
Web Apps address, so the certificate is still checked against the domain.
