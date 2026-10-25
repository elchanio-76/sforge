# staticforge

`sforge` is a command-line static site generator that scripts and AI agents can drive. It:

- builds accessible, well-formed HTML from Markdown or HTML content and a theme, with
  collections, tags, RSS/Atom feeds, a sitemap, responsive images and client-side search,
- checks the output against WCAG 2.2 AA (html-validate and axe-core in headless Chromium), and
  repairs what it safely can,
- serves a local preview with live reload and a problems overlay,
- provisions and deploys to AWS (private S3 + CloudFront) and Azure Static Web Apps with
  OpenTofu or Terraform, with versions, rollbacks and PR previews,
- offers all of this to AI agents as an MCP server, and to scripts as JSON with schemas.

## Install

Requires Node.js 22.22+ or 24.8+.

```sh
npm install --save-dev staticforge
npx sforge init my-site --title "My Site" --base-url https://www.example.com
cd my-site
npx sforge dev       # http://127.0.0.1:4321, rebuilds and reloads on every change
npx sforge check     # accessibility and link checks; --fix repairs what it safely can
npx sforge build     # → dist/
```

The rendered checks need Chromium: `npx playwright-core install --only-shell chromium` (sforge
prints the exact command when it is missing). Provisioning downloads a checksum-verified
OpenTofu on first use, or uses Terraform from your PATH.

## AI agents

```sh
claude mcp add sforge -- npx sforge mcp
```

Every command also accepts `--json` and writes one JSON document described by
`sforge schema output`.

## Documentation

- [Content](https://github.com/elchanio-76/sforge/blob/main/docs/content/content.md)
- [Themes](https://github.com/elchanio-76/sforge/blob/main/docs/content/themes.md)
- [Checking a site](https://github.com/elchanio-76/sforge/blob/main/docs/content/checker.md)
- [Provisioning and deploying](https://github.com/elchanio-76/sforge/blob/main/docs/content/deploy.md)
- [AI agents: MCP server and JSON output](https://github.com/elchanio-76/sforge/blob/main/docs/content/mcp.md)

## License

MIT
