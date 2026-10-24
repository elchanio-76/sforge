import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Diagnostic } from '@staticforge/core';
import { ProjectDirs, listFiles } from './project.js';

/**
 * Load data/*.json|yaml|yml into an object keyed by file name, so
 * `data/links.yaml` becomes `data.links` in templates. Nested directories
 * become nested objects (`data/team/people.json` → `data.team.people`).
 */
export function loadData(rootDir: string, diagnostics: Diagnostic[]): Record<string, unknown> {
  const dir = join(rootDir, ProjectDirs.data);
  const data: Record<string, unknown> = {};

  for (const file of listFiles(dir)) {
    const ext = posix.extname(file);
    if (!['.json', '.yaml', '.yml'].includes(ext)) continue;
    const projectPath = `${ProjectDirs.data}/${file}`;
    let value: unknown;
    try {
      const text = readFileSync(join(dir, file), 'utf8');
      value = ext === '.json' ? JSON.parse(text) : parseYaml(text);
    } catch (error) {
      diagnostics.push({
        ruleId: 'data-invalid',
        severity: 'error',
        message: `Cannot parse data file: ${error instanceof Error ? error.message : String(error)}`,
        file: projectPath,
      });
      continue;
    }

    const keys = file.slice(0, -ext.length).split('/');
    const name = keys.pop() ?? '';
    let target = data;
    for (const key of keys) {
      const next = target[key];
      target = (typeof next === 'object' && next !== null ? next : (target[key] = {})) as Record<
        string,
        unknown
      >;
    }
    target[name] = value;
  }
  return data;
}
