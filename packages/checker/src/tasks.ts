import { extname } from 'node:path';
import { prepareSource } from '@staticforge/content';
import { validateHtml } from './html-validate.js';
import { checkSource } from './source-rules.js';
import type { CheckPage, Finding } from './types.js';

/*
 * Per-page checks as functions of plain data, so they can run in worker threads
 * (see `WorkerPool` in @staticforge/core) or in this thread.
 */

/** Below this many pages, checks stay in the main thread: starting workers costs more. */
export const MIN_PAGES_FOR_WORKERS = 100;

export const SOURCE_TASK = { module: import.meta.url, fn: 'checkSources' };
export const VALIDATE_TASK = { module: import.meta.url, fn: 'validatePages' };

const formatOf = (path: string): 'markdown' | 'html' =>
  ['.md', '.markdown'].includes(extname(path).toLowerCase()) ? 'markdown' : 'html';

export interface SourceItem {
  page: CheckPage & { source: string };
  /** The source file as on disk. */
  text: string;
}

export interface SourceTaskContext {
  language: string;
  pageUrls: Map<string, string>;
  trailingSlash: 'always' | 'never';
}

/** The source rules for each page. */
export function checkSources(input: {
  items: SourceItem[];
  context: SourceTaskContext;
}): Finding[][] {
  return input.items.map(({ page, text }) =>
    checkSource({
      page,
      text,
      prepared: prepareSource(text, page.source, formatOf(page.source)),
      ...input.context,
    }),
  );
}

/** html-validate for each built page. */
export async function validatePages(input: {
  items: { page: CheckPage; html: string }[];
}): Promise<Finding[][]> {
  const results: Finding[][] = [];
  for (const { page, html } of input.items) results.push(await validateHtml(page, html));
  return results;
}
