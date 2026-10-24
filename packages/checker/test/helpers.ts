import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type SforgeConfigInput, validateConfig } from '@staticforge/core';

export function tempProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'sforge-check-test-'));
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  return root;
}

export function config(overrides: Partial<SforgeConfigInput> = {}) {
  return validateConfig({ site: { title: 'Test', baseUrl: 'https://example.com' }, ...overrides });
}

export const read = (root: string, path: string): string => readFileSync(join(root, path), 'utf8');

/** A complete, valid document for tests that need one. */
export const DOCUMENT = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Doc</title>
  </head>
  <body>
    <main id="main">
      <h1>Doc</h1>
    </main>
  </body>
</html>
`;
