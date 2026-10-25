---
title: staticforge documentation
description: Build, check, preview and deploy accessible static sites from the command line.
---

`sforge` is a command-line static site generator that scripts and AI agents can drive. It builds
accessible, well-formed HTML from Markdown or HTML and a theme, checks it against WCAG 2.2 AA,
serves a local preview with live reload, and provisions and deploys to AWS and Azure.

```sh
npm install --save-dev staticforge
npx sforge init my-site
cd my-site
npx sforge dev
```

## Guides

- [Content](content.md): project layout, URLs, front-matter, links, images, collections and search.
- [Themes](themes.md): the theme contract, template context and filters.
- [Checking a site](checker.md): the accessibility and correctness checks, fixes and reports.
- [Provisioning and deploying](deploy.md): AWS and Azure, versions, rollbacks and previews.
- [AI agents](mcp.md): the MCP server, `--json` output and its schemas.

These pages are built with staticforge itself from
[the docs directory of its repository](https://github.com/elchanio-76/sforge/tree/main/docs).
