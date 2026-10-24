# staticforge

`sforge` is a command-line static site generator that scripts and AI agents can drive. It:

- builds accessible, well-formed HTML from Markdown or HTML content and a theme, with
  collections, tags, RSS/Atom feeds, a sitemap, responsive images and client-side search,
- checks the output against WCAG 2.2 AA, with optional autofix,
- serves a local preview,
- provisions and deploys to AWS (private S3 + CloudFront) and Azure Static Web Apps.

> **Status:** early development (milestone M5: provisioning and deploying to AWS). See [PLAN.md](PLAN.md) for the design and roadmap.

## Development

Requires Node.js 22.22+ or 24.8+ and pnpm (the version is pinned in `package.json`; run `corepack enable`, or use `npx pnpm@12.15.0`).

```sh
pnpm install
pnpm build          # tsc project references → packages/*/dist
pnpm test           # vitest; runs against TypeScript sources, no build needed
pnpm lint && pnpm format:check
pnpm sforge --help  # run the built CLI
```

After changing the config schema, run `pnpm schema:generate` to refresh
`packages/cli/schema/staticforge.schema.json` (a test fails if it is stale).

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
```

See [docs/content.md](docs/content.md) for project layout, URLs, front-matter and links,
[docs/themes.md](docs/themes.md) for the theme contract and template context, and
[docs/checker.md](docs/checker.md) for the checks, fixes and reports, and
[docs/deploy.md](docs/deploy.md) for provisioning, deploys, versions, previews and CI roles.
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
| [`staticforge`](packages/cli)                                  | The `sforge` command-line interface                                   |

## CLI contract (for scripts and agents)

- `--json` writes exactly one JSON document to stdout; all logs go to stderr.
  The envelope is `{ schemaVersion, command, ok, data?, error? }`; see `sforge schema output`.
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
sforge config validate     # validate staticforge.config.{ts,js,json,yaml}
sforge config show         # print the resolved config with defaults
sforge schema config       # JSON Schema of the config file
sforge schema diagnostics  # JSON Schema of the check report and its diagnostics
sforge schema output       # JSON Schema of the --json envelope
sforge version
```

`sforge dev --json` and `sforge preview --json` write their envelope (with the `url`) as soon as the
server is ready, then keep running until SIGINT/SIGTERM, exiting with code 0. `--port 0` picks a free port.
Both listen on 127.0.0.1 unless `--host` is given.

`sforge build --json` and `sforge check --json` report diagnostics
(`{ ruleId, severity, message, file?, line?, column?, url?, selector?, wcag?, fixable?, hint?, helpUrl? }`)
and exit with code 1 if any are errors (for `check`: at or above `check.failOn`).
The rendered checks need Chromium; see [docs/checker.md](docs/checker.md#chromium).

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
