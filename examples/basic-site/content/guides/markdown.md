---
title: Markdown features
description: GitHub-flavored Markdown as rendered by staticforge.
---

## Tables

| Provider | Hosting               |
| -------- | --------------------- |
| AWS      | S3 + CloudFront (OAC) |
| Azure    | Static Web Apps       |

## Code

```ts
import { defineConfig } from 'staticforge';

export default defineConfig({ site: { title: 'Hi', baseUrl: 'https://example.com' } });
```

Inline `code` works too.

## Images

Images are lazy-loaded, and their paths are relative to this file:

![A diagram of content flowing from Markdown to HTML](diagram.svg)

## Task lists and footnotes

- [x] Write content
- [ ] Deploy it[^deploy]

[^deploy]: Deployment arrives in a later milestone.
