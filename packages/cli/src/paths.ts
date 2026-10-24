import { relative } from 'node:path';

/** A path for humans: relative to `cwd` when inside it, otherwise absolute. */
export function displayPath(cwd: string, path: string): string {
  const rel = relative(cwd, path);
  if (rel === '') return '.';
  return rel.startsWith('..') ? path : rel;
}
