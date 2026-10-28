# CLAUDE.md

staticforge (`sforge`) builds, checks, previews and deploys accessible static sites to AWS and
Azure. This file is for agents picking up the work: how to work here, and what earlier sessions
learned the hard way. It does not repeat what lives elsewhere:

- [README.md](README.md): install, development commands, packages, the CLI contract (`--json`
  envelope, `SF_*` error codes, exit codes, non-interactive rules) and the command list.
- [PLAN.md](PLAN.md): the living design document. §1–§14 describe the design per package, §15
  the milestones (M0–M10 done; 0.3.0 released), §16 end-to-end verification, §17 the M9 plan with
  "Done / As built / Found and fixed" notes per step, §18 the M10 plan (private sites) and §19 the
  M11 plan (Firebase Hosting).
- [RELEASING.md](RELEASING.md): npm trusted publishing, adding a package, every release.
- `docs/content/*.md`: user docs (a staticforge site): `deploy.md` (AWS, Azure, Cloudflare DNS,
  remote state, live tests), `ci.md` (`sforge ci init`, OIDC subjects), `checker.md`, `mcp.md`.

## Working agreements

- **Plans go into PLAN.md and are committed.** After a plan is approved, write it into PLAN.md
  (a new section, as §17 for M9) and keep it current as decisions land: mark steps done and add
  "As built" notes with what differed and what was found. The plan-mode file alone is not enough.
- **Ask before creating or destroying cloud resources** (provision, destroy, live tests, deploys
  to real targets), every time; approval for one run does not carry over to the next. Read-only
  checks (`--diff`, listing resources, the Cloudflare MCP) need no approval.
- Commit messages: a short subject, a body that says why, and the attribution line the
  harness gives. Commit to `main` (the user's workflow); push when asked or as part of an
  agreed release.
- Match the surrounding code: ESM TypeScript (strict), optional fields added by spreading
  (`...(x !== undefined && { x })`), errors as `SforgeError` with a stable `ErrorCode` and a
  `hint`, comments that explain why. User docs avoid filler; keep sentences short.

## Checks before committing

`pnpm format && pnpm lint && pnpm typecheck && pnpm test`, plus as relevant:

- Config schema or a command's `--json` data changed: `pnpm schema:generate` (a test fails if
  the committed schemas are stale).
- HCL modules changed: `pnpm test:iac`, and `tofu init -backend=false && tofu test` in each
  changed module directory (CI does this, see `.github/workflows/ci.yml`). Delete the
  `.terraform/` and lock file that creates there (they are not tracked).
- Docs changed: `pnpm build && pnpm sforge build --cwd docs && pnpm sforge check --cwd docs --headless`.
- Packaging, dependencies or a release: `pnpm test:pack`.
- `sforge ci init` templates changed: run the generated workflows through `actionlint` (with
  `shellcheck`); not installed globally, download a release binary into the scratchpad.
- Known flaky under full-suite load (predate M9, not fixed): the dev-server tests "writes the
  search index after serving each build", "removes its temporary builds on close" and (seen
  once, 0.3.0) "marks stylesheet-only changes so the client can swap CSS without reloading".
  Rerun before investigating.

## Cloud and service access

IDs (accounts, subscriptions, zone) are kept out of this public repository: read them from the
CLIs (`aws sts get-caller-identity`, `az account show`) or the Cloudflare MCP.

- **AWS**: always `AWS_PROFILE=sandbox` (SSO, region eu-north-1, state bucket
  `sforge-state-<account>-eu-north-1`). The default profile is a different account: leave it
  alone. When the SSO session has expired (`Token is expired`), ask the user to run
  `! aws sso login --profile sandbox` (it opens a browser).
- **Azure**: "Subscription 2" (empty, Owner), not "Azure subscription 1" (the user's own
  resources). The az CLI needs `HOMEBREW_CURL_PATH=/usr/local/bin/curl`. West Europe refuses
  new Storage and Static Web Apps for this subscription: use `eastus2` for SWA and
  `state: { location: 'northeurope' }`. The shared state account in resource group
  `sforge-state` is kept on purpose (live tests reuse it).
- **Cloudflare**: zone `elchanio-76.eu` (DNS only, Free plan, DNSSEC on, no CAA). sforge's
  records live under `sforge.elchanio-76.eu`; never create them by hand. `CLOUDFLARE_API_TOKEN`
  comes from the project's `.envrc` (direnv, gitignored): in non-interactive shells run
  `direnv exec <repo> <command>`, and never print the token. The `cloudflare-api` MCP (code
  mode, read-only) is for pre-flight checks and verifying that destroys left no records.
- **GitHub**: `elchanio-76/sforge` (public, `main`). The `gh` token has no `workflow` scope, so
  pushes that touch `.github/workflows/` over HTTPS are refused: push over SSH. In this sandbox,
  git cannot start `ssh` from outside the repository directory, so clone other repositories over
  HTTPS and then switch the remote to `git@github.com:…`.
- **CI test repository** `elchanio-76/sforge-ci-test` (public, npm, environment `production`
  with the user as reviewer, `main` only): used in M9 to verify `sforge ci init` (PLAN §17 F).
  Its cloud resources are destroyed and its three workflows are disabled; re-provisioning
  requires re-enabling them and new repository variables (`sforge ci init` prints them).
  Pushing a workflow-only change with `[skip ci]` avoids triggering deploys.

## Tooling quirks

- A global hook refuses Bash commands containing the word "credentials" (also inside longer
  names) or key-file-like text such as HCL's `each.key`, even in heredocs that only write docs or
  HCL. Write such files with the Write/Edit tools, phrase docs around the word ("federated
  logins", "your AWS profile or SSO session"), and do not try to get around the hook.
- Foreground `sleep` is blocked; wait on CI with the Monitor tool or a background
  `gh run watch`.
- OpenTofu is downloaded by sforge to `~/.cache/staticforge/bin/tofu-<version>/tofu`; Terraform
  is on PATH. pnpm is pinned in `package.json` (Node 26 has no corepack; pnpm is installed
  globally).

## Lessons learned (M8–M9)

Releases and npm:

- Each package needs its own npm trusted-publisher entry with **"npm publish" ticked**, or the
  workflow fails with `404 Not Found - PUT` / `403 OIDC permission denied`. A new package is
  first published by hand by the user, then gets its entry (RELEASING.md "Adding a package").
- Prereleases (`x.y.z-rc.N`) go to the dist-tag `next` (`scripts/publish.mjs`). Bump with
  `node scripts/version.mjs <v>`, `pnpm install`, commit, tag `v<v>`, push; the tag must match
  the package versions.
- Right after a release, npm can take a minute or two to serve every package (`ETARGET` for one
  of them): poll `npm view <pkg>@<v> --prefer-online` before installing.

GitHub Actions and OIDC:

- Repositories created since July 2026 use **immutable OIDC subjects**
  (`repo:owner@<id>/repo@<id>:…`). `provision` reads the prefix from
  `GET /repos/{repo}/actions/oidc/customization/sub` or `ci.subjectPrefix`; never build subjects
  from `owner/repo` alone.
- CI identities are deliberately minimal (AWS: own bucket, KVS, invalidations, own state key;
  Azure: a custom role on the one Static Web App plus ABAC-limited blob access). Code that runs
  in CI must not call anything wider. Example: Azure SDK long-running-operation pollers read
  operation status at **subscription** scope, so send the request (`.submitted()`) and poll the
  resource yourself.
- Nothing may be written into the checkout during a deploy: a dirty tree marks the version
  unrebuildable, and Azure rollbacks rebuild the commit. `gitIsDirty` ignores `.sforge/`; the
  workflows write to `$RUNNER_TEMP`.
- Every generated job has `timeout-minutes` (an apt mirror once hung a Chromium install).

Clouds and DNS:

- Azure refuses a custom domain whose CNAME does not resolve yet (`51021 CNAME Record is
invalid`) and does not retry: the Azure profile applies the app and CNAME first, waits until
  the zone's own nameservers answer (`waitForCname`), then adds the domain.
- CloudFront KeyValueStore switches (deploy, rollback) reach most edges in seconds and all of
  them within a few minutes; account for that when verifying rollbacks.
- AWS previews on a custom domain are public: preview builds add
  `<meta name="robots" content="noindex">` (Azure previews get `X-Robots-Tag` from SWA).
- The project name (resource names, state keys) comes from `iac.name`, else the host of
  `site.baseUrl`. Changing it later recreates everything; set `iac.name` up front when targets
  have their own domains.
- `apply` logs "Drift detected" for resources it has just created (azuread, the SWA after its
  custom domain); a following `provision --diff` shows no changes. Cosmetic; not yet filtered.

Live tests (`pnpm test:live`, see `docs/content/deploy.md` "Live tests") create and destroy real
resources (about 11–12 minutes per cloud, with a custom domain); they need the user's approval,
`SFORGE_LIVE_CONFIRM=<account or subscription id>`, and for the domain mode
`SFORGE_LIVE_DOMAIN`, `SFORGE_LIVE_DNS_ZONE` and the Cloudflare token. Afterwards check the zone
for leftover records through the MCP.
