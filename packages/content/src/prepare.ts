import type { Diagnostic } from '@staticforge/core';
import { extractFrontMatter } from './frontmatter.js';
import { type PageMeta, validatePageMeta } from './page-meta.js';

export type ContentFormat = 'markdown' | 'html';

/** A source file with its front-matter read: enough to compute URLs before parsing. */
export interface PreparedSource {
  /** Project-relative path, used in diagnostics. */
  path: string;
  format: ContentFormat;
  hasFrontMatter: boolean;
  meta: PageMeta;
  body: string;
  diagnostics: Diagnostic[];
}

export function prepareSource(source: string, path: string, format: ContentFormat): PreparedSource {
  const frontMatter = extractFrontMatter(source, path);
  const { meta, diagnostics } = validatePageMeta(frontMatter, path);
  return {
    path,
    format,
    hasFrontMatter: frontMatter.present,
    meta,
    body: frontMatter.body,
    diagnostics: [...frontMatter.diagnostics, ...diagnostics],
  };
}
