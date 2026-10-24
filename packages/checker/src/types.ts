import type { Diagnostic } from '@staticforge/core';
import type { TextEdit } from './text.js';

/**
 * Where a finding comes from:
 * - `build`: reported while building (front-matter, image alt, broken source links…)
 * - `source`: checker rules on content sources; these carry exact positions and fixes
 * - `output`: static rules on the built HTML (custom rules and html-validate)
 * - `rendered`: axe-core in headless Chromium
 */
export type Layer = 'build' | 'source' | 'output' | 'rendered';

export interface Finding {
  layer: Layer;
  diagnostic: Diagnostic;
  /** Edits to `diagnostic.file` that fix the problem. */
  edits?: TextEdit[];
  /**
   * Identifies the problem across layers (e.g. a link's resolved target), so
   * an output finding already reported at its source can be dropped.
   */
  match?: string;
}

/** A built page, as the checker sees it. */
export interface CheckPage {
  url: string;
  /** Project-relative source file; undefined for generated pages (e.g. the default 404). */
  source: string | undefined;
  /** Output file, POSIX-relative to the build directory. */
  output: string;
  /** `document` pages are full HTML documents that pass through the build unwrapped. */
  kind: 'document' | 'fragment' | 'generated';
}
