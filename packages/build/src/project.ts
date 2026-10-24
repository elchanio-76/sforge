import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ErrorCode, SforgeError } from '@staticforge/core';

/** Conventional project directories, relative to the project root. */
export const ProjectDirs = {
  /** Pages (Markdown/HTML) plus co-located files copied alongside them. */
  content: 'content',
  /** Copied verbatim to the site root. */
  static: 'static',
  /** Copied to /assets/ (processed in a later milestone). */
  assets: 'assets',
  /** Project overrides for theme templates. */
  templates: 'templates',
  /** JSON/YAML files exposed to templates as `data`. */
  data: 'data',
} as const;

export const PAGE_EXTENSIONS = new Set(['.md', '.markdown', '.html', '.htm']);

/**
 * Resolve the output directory and refuse anything we must never delete: the
 * project root, anything outside it, or a directory holding project sources.
 */
export function resolveOutDir(rootDir: string, outDir: string): string {
  const absolute = isAbsolute(outDir) ? outDir : resolve(rootDir, outDir);
  const rel = relative(rootDir, absolute);
  const unsafe = (reason: string) =>
    new SforgeError(
      ErrorCode.UnsafePath,
      `Refusing to use ${absolute} as the output directory: ${reason}`,
      {
        hint: 'Set build.outDir to a dedicated directory inside the project, such as "dist".',
      },
    );

  if (rel === '') throw unsafe('it is the project root');
  if (rel.startsWith('..') || isAbsolute(rel)) throw unsafe('it is outside the project');
  const top = rel.split(sep)[0] ?? '';
  if (
    (Object.values(ProjectDirs) as string[]).includes(top) ||
    top === 'node_modules' ||
    top.startsWith('.')
  ) {
    throw unsafe(`it would overwrite the project's ${top}/ directory`);
  }
  return absolute;
}

/**
 * Validate a scratch output directory (used by `sforge dev`): it must be a
 * subdirectory of the OS temp directory, so a rebuild can never delete
 * project files.
 */
export function resolveScratchDir(dir: string): string {
  const absolute = resolve(dir);
  const rel = relative(tmpdir(), absolute);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new SforgeError(
      ErrorCode.UnsafePath,
      `Scratch output directory ${absolute} is not inside ${tmpdir()}`,
    );
  }
  return absolute;
}

/**
 * List files under `dir` as POSIX paths relative to it. Skips dot-files,
 * dot-directories and node_modules. Returns [] if the directory is missing.
 */
export function listFiles(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .filter(
      (path) => !path.split('/').some((part) => part.startsWith('.') || part === 'node_modules'),
    )
    .sort();
}
