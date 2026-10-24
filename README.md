# staticforge

`sforge` is a command-line static site generator that scripts and AI agents can drive. It:

- builds accessible, well-formed HTML from Markdown or HTML content and a theme,
- checks the output against WCAG 2.2 AA, with optional autofix,
- serves a local preview,
- provisions and deploys to AWS (private S3 + CloudFront) and Azure Static Web Apps.

> **Status:** early development (milestone M2: local preview). See [PLAN.md](PLAN.md) for the design and roadmap.

## Development

Requires Node.js ≥ 22.12 and pnpm (the version is pinned in `package.json`; run `corepack enable`, or use `npx pnpm@12.15.0`).

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
sforge build            # → dist/
sforge preview          # serve dist/ exactly as production will
```

See [docs/content.md](docs/content.md) for project layout, URLs, front-matter and links, and
[docs/themes.md](docs/themes.md) for the theme contract and template context.
[examples/basic-site](examples/basic-site) shows every content type.

## Packages

| Package                                                | Purpose                                                              |
| ------------------------------------------------------ | -------------------------------------------------------------------- |
| [`@staticforge/core`](packages/core)                   | Config schema and loading, diagnostics, error and exit codes, logger |
| [`@staticforge/content`](packages/content)             | Front-matter, Markdown/HTML parsing, accessibility transforms        |
| [`@staticforge/render`](packages/render)               | Theme loading and Nunjucks rendering                                 |
| [`@staticforge/theme-default`](packages/theme-default) | The accessible default theme                                         |
| [`@staticforge/build`](packages/build)                 | Site build pipeline, `init` and `new` scaffolding                    |
| [`@staticforge/dev-server`](packages/dev-server)       | `dev` (watch, live reload, problems overlay) and `preview` servers   |
| [`staticforge`](packages/cli)                          | The `sforge` command-line interface                                  |

## CLI contract (for scripts and agents)

- `--json` writes exactly one JSON document to stdout; all logs go to stderr.
  The envelope is `{ schemaVersion, command, ok, data?, error? }`; see `sforge schema output`.
- Errors carry a stable `error.code` (`SF_CONFIG_INVALID`, `SF_CONFIG_NOT_FOUND`, …). Match on the code, not the message.
- Exit codes: `0` success, `1` the command ran and found failures, `2` usage or config error, `3` internal error.
- `--non-interactive` (implied when `CI` is set or stdin is not a TTY) never prompts.

### Commands available so far

```
sforge init [dir]          # scaffold a project (--format ts|json|yaml, --provider aws|azure)
sforge new page|post <path> # create content with front-matter
sforge build               # build into dist/ (--drafts, --out, --base-url)
sforge dev                 # build, serve and live-reload (--port, --host, --open, --drafts)
sforge preview             # serve an existing build (--port, --host, --open, --dir)
sforge config validate     # validate staticforge.config.{ts,js,json,yaml}
sforge config show         # print the resolved config with defaults
sforge schema config       # JSON Schema of the config file
sforge schema output       # JSON Schema of the --json envelope
sforge version
```

`sforge dev --json` and `sforge preview --json` write their envelope (with the `url`) as soon as the
server is ready, then keep running until SIGINT/SIGTERM, exiting with code 0. `--port 0` picks a free port.
Both listen on 127.0.0.1 unless `--host` is given.

`sforge build --json` reports every page and a list of diagnostics
(`{ ruleId, severity, message, file, line, column, wcag?, hint? }`) and exits with code 1 if any are errors.

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
