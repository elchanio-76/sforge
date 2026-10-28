# M12 review log

Findings from the whole-repository review (PLAN §20). One entry per finding: id (`Q-n` quality,
`S-n` security, `P-n` CLI ↔ MCP parity), area and `file:line`, severity, what is wrong, the
decision, and the fixing commit or the reason it is deferred.

## Baseline (main at 0.3.0 + `9a23cea`, 2026-10-28)

| Measure                        | Result                                                                                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tests                          | 552 passed, 16 skipped (live and IaC), 45 files; 8.8 s                                                                                                                                                             |
| Coverage (v8, lines)           | total 91.0 %, branches 82.1 %                                                                                                                                                                                      |
| Coverage by package            | assets 94.7, build 97.8, checker 97.7, cli 84.5, content 97.3, core 92.5, dev-server 92.2, render 93.2, server 93.0, aws 89.7, azure 80.8, cloudflare 100, iac 94.5, provider-api 94.7                             |
| `pnpm audit --prod`            | 13 advisories (8 high, 3 moderate, 2 low), all via `@azure/static-web-apps-cli` (PLAN §20 B)                                                                                                                       |
| `pnpm audit --dev`             | none                                                                                                                                                                                                               |
| `actionlint` 1.7.12            | clean (repository workflows)                                                                                                                                                                                       |
| `zizmor` (offline)             | 16 findings: 10 `unpinned-uses` (ci.yml), 4 `artipacked`, 1 `cache-poisoning`, 1 `adhoc-packages` (release.yml)                                                                                                    |
| `knip` 6.43                    | 9 unused files (mostly false positives: entry points, scripts, theme/Lambda assets), 3 unused dependencies, 1 unused devDependency, 1 unlisted dependency, 8 unused exports, 3 unused types                        |
| `as` casts in `packages/*/src` | about 41 (rough grep), 1 non-null `!`, 17 `new Error(`                                                                                                                                                             |
| Layering                       | core imports no `@staticforge` package; providers import only core, iac, provider-api, server, build (azure); no provider imports another provider or the CLI. `provider-api` imports build, core, iac and server. |
| Not run yet                    | `tflint`, `trivy config`/`checkov` (not installed), `terraform`/`tofu validate`                                                                                                                                    |

Coverage is measured with `@vitest/coverage-v8` (added as a root dev dependency); no gate yet.
`packages/server/src/static-server.ts` is at 91 % through other tests, so Q-4 below is about a
test of its own, not a gap.

## Findings

| Id  | Area                                                      | Severity | Finding                                                                                                                                                                                                                                               | Decision                                                     | Fix  |
| --- | --------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---- |
| S-1 | `.github/workflows/ci.yml:24-26` and 7 more lines         | medium   | Actions referenced by tag (`actions/checkout@v4`, `pnpm/action-setup@v4`, `actions/setup-node@v4`), not by commit SHA. `release.yml` is pinned. The release job is the sensitive one, but a moved tag runs in every CI job with the repository token. | Pin to SHAs via `scripts/ci-pins.mjs`.                       | open |
| S-2 | `.github/workflows/release.yml:21` (and 3 more checkouts) | low      | `actions/checkout` without `persist-credentials: false`; the token stays in `.git/config` for later steps.                                                                                                                                            | Set `persist-credentials: false` where no step pushes.       | open |
| S-3 | `.github/workflows/release.yml:23`                        | low      | `setup-node` with `cache: pnpm` in the publishing job: a poisoned cache from another workflow could reach a job that publishes with OIDC.                                                                                                             | Drop the cache in `release.yml`.                             | open |
| S-4 | `.github/workflows/release.yml:29`                        | info     | `npm install --global npm@11` is unpinned and outside the lockfile (needed for trusted publishing).                                                                                                                                                   | Pin the minor version; note the reason in a comment.         | open |
| Q-1 | `scripts/publish.mjs`                                     | low      | Fails on the two 409s seen with 0.3.0 instead of waiting and retrying.                                                                                                                                                                                | Retry with backoff.                                          | open |
| Q-2 | knip: `packages/*/package.json`                           | low      | Unused dependencies: `@staticforge/core` (assets), `shiki` (content), `@staticforge/theme-default` (render); unused `@types/mdast` (content); `playwright-core` unlisted (live-auth test).                                                            | Check each (some may be loaded dynamically); remove or list. | open |
| Q-3 | knip: unused exports                                      | low      | `CODE`, `IMAGE_DIR`, `elementsOf`, `selectorOf`, `providerFor`, `dnsProfileFor`, `commandPath`, `TABLE_SCROLL_CLASS` and three types are exported and never imported.                                                                                 | Un-export or delete.                                         | open |
| Q-4 | `packages/server/src/static-server.ts`                    | info     | No test file of its own (covered at 91 % through dev-server and preview tests).                                                                                                                                                                       | Add a focused traversal test during S review (D.4).          | open |

Findings from the security, parity and quality passes are added here as they are made.

## Threat model

To be written with step D (PLAN §20 F.3).

## CLI ↔ MCP inventory

To be written with step E.
