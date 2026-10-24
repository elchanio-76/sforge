import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import * as pagefind from 'pagefind';

export interface SearchPage {
  /** Root-relative page URL. */
  url: string;
  html: string;
}

/** Directory of the search index inside the build, served at /pagefind/. */
export const SEARCH_DIR = 'pagefind';

/**
 * Index the pages with Pagefind and write the index and its client library to
 * `<outDir>/pagefind/`. Only elements marked `data-pagefind-body` are indexed.
 *
 * @returns Output files, POSIX-relative to outDir.
 */
export function writeSearchIndex(pages: SearchPage[], outDir: string): Promise<string[]> {
  // Pagefind runs one service per process, and close() stops it for every
  // caller, so builds in the same process (dev server, checker) take turns.
  const run = queue.then(() => indexPages(pages, outDir));
  queue = run.catch(() => undefined);
  return run;
}

let queue: Promise<unknown> = Promise.resolve();

async function indexPages(pages: SearchPage[], outDir: string): Promise<string[]> {
  const { index, errors } = await pagefind.createIndex({});
  if (index === undefined) throw new Error(`Pagefind failed to start: ${errors.join('; ')}`);
  try {
    for (const page of pages) {
      const added = await index.addHTMLFile({ url: page.url, content: page.html });
      if (added.errors.length > 0)
        throw new Error(`Pagefind could not index ${page.url}: ${added.errors.join('; ')}`);
    }
    const dir = join(outDir, SEARCH_DIR);
    const written = await index.writeFiles({ outputPath: dir });
    if (written.errors.length > 0)
      throw new Error(`Pagefind could not write its index: ${written.errors.join('; ')}`);
    return listFiles(dir).map((file) => relative(outDir, file).split(sep).join('/'));
  } finally {
    await index.deleteIndex();
    await pagefind.close();
  }
}

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}
