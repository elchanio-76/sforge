import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** Create a temporary directory populated with the given files (path → contents). */
export function tempProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'sforge-test-'));
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

export const minimalConfig = {
  site: { title: 'Test site', baseUrl: 'https://example.com' },
};
