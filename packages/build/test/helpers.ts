import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type SforgeConfigInput, validateConfig } from '@staticforge/core';

export function tempProject(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), 'sforge-build-'));
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

/** A valid 64×48 PNG, small enough to inline. */
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAMAAACWlYwtAAAAA1BMVEU6bqXTREzSAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGklEQVRIx+3BgQAAAADDoPlTX+AIVQEAAHwDDDAAAcvAQmMAAAAASUVORK5CYII=',
  'base64',
);
