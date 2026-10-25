# staticforge

`sforge` is a command-line static site generator that scripts and AI agents can drive. It:

- builds accessible, well-formed HTML from Markdown or HTML content and a theme, with
  collections, tags, RSS/Atom feeds, a sitemap, responsive images and client-side search,
- checks the output against WCAG 2.2 AA, with optional autofix,
- serves a local preview with live reload and fast incremental rebuilds,
- provisions and deploys to AWS (private S3 + CloudFront) and Azure Static Web Apps,
- offers all of this to AI agents as an MCP server, and to scripts as JSON with schemas.

> **Status:** early development (milestone M8: hardening and the first npm release). See [PLAN.md](PLAN.md) for the design and roadmap.

## Install

```sh
npm install --save-dev staticforge    # Node.js 22.22+ or 24.8+; then run it as `npx sforge`
```

## Development

Requires Node.js 22.22+ or 24.8+ and pnpm (the version is pinned in `package.json`; run `corepack enable`, or use `npx pnpm@12.15.0`).

```sh
pnpm install
pnpm build          # tsc project references → packages/*/dist
pnpm test           # vitest; runs against TypeScript sources, no build needed
pnpm lint && pnpm format:check
pnpm sforge --help  # run the built CLI
pnpm bench          # build, check and dev-rebuild timings on a synthetic 2,000-page site
pnpm test:pack      # install the packed packages into a new project and use them
pnpm test:iac       # validate the generated OpenTofu/Terraform workspaces
pnpm test:live      # the full cloud cycle in a sandbox account (see docs/content/deploy.md)
pnpm sforge check --cwd docs --headless   # the documentation is a staticforge site
```

Releases: see [RELEASING.md](RELEASING.md).

After changing the config schema or the `--json` data of a command, run `pnpm schema:generate`
to refresh the schemas in `packages/cli/schema/` (a test fails if they are stale).

## Quick start

```sh
sforge init my-site --title "My Site" --base-url https://www.example.com
cd my-site
sforge new page guides/getting-started
sforge new post hello-world
sforge dev              # http://127.0.0.1:4321, rebuilds and reloads on every change
sforge check            # accessibility and link checks; --fix repairs what it safely can
sforge build            # → dist/
sforge preview          # serve dist/ exactly as production will
sforge provision staging --bootstrap-state   # AWS: private S3 + CloudFront (OpenTofu/Terraform)
sforge deploy staging   # build, check, upload a new version and switch to it
claude mcp add sforge -- npx sforge mcp      # let an AI agent build, check and fix the site
```

See [docs/content/content.md](docs/content/content.md) for project layout, URLs, front-matter and links,
[docs/content/themes.md](docs/content/themes.md) for the theme contract and template context, and
[docs/content/checker.md](docs/content/checker.md) for the checks, fixes and reports,
[docs/content/deploy.md](docs/content/deploy.md) for provisioning, deploys, versions, previews and CI roles, and
[docs/content/mcp.md](docs/content/mcp.md) for the MCP server, `--json` output and its schemas.
[examples/basic-site](examples/basic-site) shows every content type.

## Packages

| Package                                                        | Purpose                                                               |
| -------------------------------------------------------------- | --------------------------------------------------------------------- |
| [`@staticforge/core`](packages/core)                           | Config schema and loading, diagnostics, error and exit codes, logger  |
| [`@staticforge/content`](packages/content)                     | Front-matter, Markdown/HTML parsing, accessibility transforms         |
| [`@staticforge/render`](packages/render)                       | Theme loading and Nunjucks rendering                                  |
| [`@staticforge/theme-default`](packages/theme-default)         | The accessible default theme                                          |
| [`@staticforge/assets`](packages/assets)                       | Images (sharp), CSS (Lightning CSS), JS (esbuild), search (Pagefind)  |
| [`@staticforge/build`](packages/build)                         | Build pipeline, collections, tags, feeds, sitemap, `init` and `new`   |
| [`@staticforge/server`](packages/server)                       | Static file server with the production URL semantics                  |
| [`@staticforge/checker`](packages/checker)                     | `check`: source, output and headless (axe-core) rules, fixes, reports |
| [`@staticforge/dev-server`](packages/dev-server)               | `dev` (watch, live reload, problems overlay) and `preview` servers    |
| [`@staticforge/iac`](packages/providers/iac)                   | OpenTofu/Terraform: engine download, workspaces, runner, state        |
| [`@staticforge/provider-api`](packages/providers/provider-api) | Provider interface, manifests, cache and security headers             |
| [`@staticforge/aws`](packages/providers/aws)                   | AWS: HCL modules, S3 + CloudFront deployer, versions, previews        |
| [`@staticforge/azure`](packages/providers/azure)               | Azure: HCL modules, Static Web Apps deployer, previews, rollback      |
| [`staticforge`](packages/cli)                                  | The `sforge` command-line interface and MCP server                    |

## CLI contract (for scripts and agents)

- `--json` writes exactly one JSON document to stdout; all logs go to stderr.
  The envelope is `{ schemaVersion, command, ok, data?, error? }`; `sforge schema output` describes
  it, including every command's `data` (also shipped as `schema/output.schema.json`).
- Errors carry a stable `error.code` (`SF_CONFIG_INVALID`, `SF_CONFIG_NOT_FOUND`, …). Match on the code, not the message.
- Exit codes: `0` success, `1` the command ran and found failures, `2` usage or config error, `3` internal error.
- `--non-interactive` (implied when `CI` is set or stdin is not a TTY) never prompts:
  `provision` and `rollback` then need `--yes`, `destroy` needs `--confirm <target>`
  (`SF_CONFIRMATION_REQUIRED` otherwise).

### Commands available so far

```
sforge init [dir]          # scaffold a project (--format ts|json|yaml, --provider aws|azure)
sforge new page|post <path> # create content with front-matter
sforge build               # build into dist/ (--drafts, --out, --base-url)
sforge dev                 # build, serve and live-reload (--port, --host, --open, --drafts)
sforge preview             # serve an existing build (--port, --host, --open, --dir)
sforge check               # check the site (--fix, --dry-run, --no-headless, --pages, --format, --output)
sforge provision <target>  # create/update infrastructure (--diff, --bootstrap-state, --local-state, --no-wait, --yes)
sforge status <target>     # URL, active version, drift (exit 1 on drift)
sforge iac <cmd> <target>  # path, or init|plan|apply|output|state|… in the generated workspace
sforge deploy <target>     # build, check, deploy (--preview <id>, --no-build, --no-check, --dry-run, --invalidate)
sforge versions <target>   # deployed versions and previews
sforge rollback <target>   # serve the previous version (--to <versionId>, --yes)
sforge preview-destroy <target> <id>
sforge destroy <target> --confirm <target>
sforge ci init             # GitHub Actions workflows: checks, PR previews, deploys (--targets, --force)
sforge config validate     # validate staticforge.config.{ts,js,json,yaml}
sforge config show         # print the resolved config with defaults
sforge schema config       # JSON Schema of the config file
sforge schema diagnostics  # JSON Schema of the check report and its diagnostics
sforge schema output       # JSON Schema of the --json envelope and each command's data
sforge version
sforge mcp                 # MCP server on stdio for AI agents (--allow-infra adds provision/destroy)
```

`sforge dev --json` and `sforge preview --json` write their envelope (with the `url`) as soon as the
server is ready, then keep running until SIGINT/SIGTERM, exiting with code 0. `--port 0` picks a free port.
Both listen on 127.0.0.1 unless `--host` is given.

`sforge build --json` and `sforge check --json` report diagnostics
(`{ ruleId, severity, message, file?, line?, column?, url?, selector?, wcag?, fixable?, hint?, helpUrl? }`)
and exit with code 1 if any are errors (for `check`: at or above `check.failOn`).
The rendered checks need Chromium; see [docs/content/checker.md](docs/content/checker.md#chromium).

## Configuration

`staticforge.config.ts`, `.js`, `.mjs`, `.json`, `.yaml` or `.yml`, searched for from the current directory upwards:

```ts
import { defineConfig } from 'staticforge';

export default defineConfig({
  site: { title: 'My site', baseUrl: 'https://www.example.com' },
  targets: {
    staging: { provider: 'aws', region: 'eu-central-1', ci: { repo: 'me/my-site' } },
    prod: { provider: 'azure', resourceGroup: 'rg-my-site', location: 'westeurope' },
  },
});
```

For JSON or YAML configs, add `"$schema": "./node_modules/staticforge/schema/staticforge.schema.json"` for editor completion.
