# Provisioning and deploying

`sforge` separates two kinds of work:

- **Infrastructure** (buckets, the CDN, certificates, DNS, CI identities) is created by
  `sforge provision` with packaged HCL modules, run by **OpenTofu** (default) or
  **Terraform**. It changes rarely.
- **Content** is uploaded by `sforge deploy` with the cloud SDK. Every deploy is a new
  version; switching versions (deploy, rollback) takes seconds.

AWS targets are available now. Azure Static Web Apps follows in milestone M6.

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

The search page also gets `'wasm-unsafe-eval'` in `script-src`, because Pagefind uses
WebAssembly. Inline style attributes are allowed for code highlighting; inline scripts are not.
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
by this target. `sforge ci init` (milestone M7) will generate the workflows.

## Destroying

```sh
sforge destroy staging --confirm staging
```

Removes every resource of the target, including all deployed versions. The state bucket and its
state file history are kept.

## Credentials and errors

AWS credentials come from the SDK's default chain (`AWS_PROFILE`, SSO, environment, OIDC in CI),
both for sforge and for the engine. Missing or expired credentials fail with `SF_CLOUD_AUTH`.
Other error codes: `SF_ENGINE_MISSING`, `SF_STATE_MISSING`, `SF_NOT_PROVISIONED`,
`SF_IAC_FAILED` (with the engine's diagnostics in `details`), `SF_CONFIRMATION_REQUIRED`
(non-interactive runs need `--yes`), `SF_DEPLOY_FAILED`, `SF_VERSION_NOT_FOUND`,
`SF_UNSUPPORTED`.

## Testing the modules

```sh
cd packages/providers/aws/terraform/modules/site
tofu init -backend=false && tofu test     # mocked AWS: no account needed
pnpm test:iac                             # validate the generated workspaces with tofu/terraform
```
