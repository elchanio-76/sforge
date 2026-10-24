import type { Element, Root } from 'hast';
import { fromHtml } from 'hast-util-from-html';
import { toString } from 'hast-util-to-string';
import rehypeShiki from '@shikijs/rehype';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import rehypeRaw from 'rehype-raw';
import rehypeSlug from 'rehype-slug';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import { VFile } from 'vfile';
import type { Diagnostic } from '@staticforge/core';
import type { PageMeta } from './page-meta.js';
import type { PreparedSource } from './prepare.js';
import {
  type Heading,
  collectHeadings,
  shiftHeadings,
  takeTitleHeading,
} from './transforms/headings.js';
import { transformNewTabLinks } from './transforms/links.js';
import { transformMedia } from './transforms/media.js';
import { type ResolveRef, resolveRefs } from './transforms/refs.js';
import { type Report, createReport } from './transforms/report.js';

/**
 * `fragment`: content to wrap in a theme layout.
 * `document`: a complete HTML document that passes through unwrapped.
 */
export type ContentKind = 'fragment' | 'document';

export interface ParseOptions {
  /** Site language, used when the page sets no `lang`. */
  language: string;
  /** Rewrite URL references (e.g. `other.md` → `/other/`). */
  resolveRef?: ResolveRef;
  /** Whether a root-relative URL path exists in the built site. */
  fileExists?: (urlPath: string) => boolean;
}

export interface ParsedContent {
  kind: ContentKind;
  meta: PageMeta;
  title: string;
  lang: string;
  /** For fragments, the content; for documents, the whole document. */
  tree: Root;
  /** Headings below the title, for tables of contents. */
  headings: Heading[];
  diagnostics: Diagnostic[];
}

const markdownToHast = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw);

/** Final passes for wrapped content: heading ids and anchors, code highlighting. */
const enhanceFragment = unified()
  .use(rehypeSlug)
  .use(rehypeAutolinkHeadings, {
    behavior: 'wrap',
    // Wrapping a heading that already contains a link would nest links.
    test: (node: Element) => !node.children.some((c) => c.type === 'element' && c.tagName === 'a'),
  })
  .use(rehypeShiki, {
    themes: { light: 'github-light', dark: 'github-dark' },
    defaultColor: false,
    // Load grammars on first use. Without `langs: []` every bundled grammar is
    // loaded up front (~2s), even with `lazy`.
    langs: [],
    lazy: true,
    fallbackLanguage: 'text',
  });

const DOCUMENT = /^\s*(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\s|<html[\s>])/i;

/** "about-us" → "About us": a last-resort title. */
export function titleFromPath(path: string): string {
  const base =
    path
      .split('/')
      .pop()
      ?.replace(/\.[^.]+$/, '') ?? '';
  const stem = base === 'index' || base === '_index' ? (path.split('/').at(-2) ?? 'Home') : base;
  const words = stem.replace(/[-_]+/g, ' ').trim();
  return words === '' ? 'Untitled' : words.charAt(0).toUpperCase() + words.slice(1);
}

function parseHtml(
  source: PreparedSource,
  report: Report,
): { kind: ContentKind; tree: Root; docTitle?: string } {
  const isDocument = DOCUMENT.test(source.body);
  // parse5 reports tokenizer errors only; tree-construction problems (e.g.
  // stray end tags) are left to the checker's html-validate rules.
  const tree = fromHtml(source.body, {
    fragment: !isDocument,
    onerror: (error) => {
      report(
        {
          ruleId: 'html-parse',
          severity: 'warning',
          message: `HTML is not well-formed: ${error.reason}`,
          ...(error.url !== undefined && { hint: error.url }),
        },
        error.line !== undefined && error.column !== undefined
          ? {
              type: 'text',
              position: {
                start: { line: error.line, column: error.column },
                end: { line: error.line, column: error.column },
              },
            }
          : undefined,
      );
    },
  });
  if (!isDocument) return { kind: 'fragment', tree };

  let docTitle: string | undefined;
  let body: Element | undefined;
  visit(tree, 'element', (node: Element) => {
    if (node.tagName === 'title' && docTitle === undefined) docTitle = toString(node).trim();
    if (node.tagName === 'body') body = node;
  });

  // A full document with front-matter opts in to the theme: wrap its body.
  if (source.hasFrontMatter) {
    return {
      kind: 'fragment',
      tree: { type: 'root', children: body?.children ?? [] },
      ...(docTitle && { docTitle }),
    };
  }
  return { kind: 'document', tree, ...(docTitle && { docTitle }) };
}

/** Parse a prepared Markdown or HTML source into an enhanced, accessible hast tree. */
export async function parseContent(
  source: PreparedSource,
  options: ParseOptions,
): Promise<ParsedContent> {
  const diagnostics: Diagnostic[] = [...source.diagnostics];
  const report = createReport(source.path, diagnostics);
  const lang = source.meta.lang ?? options.language;
  const file = new VFile({ path: source.path, value: source.body });

  let kind: ContentKind = 'fragment';
  let tree: Root;
  let docTitle: string | undefined;
  if (source.format === 'markdown') {
    tree = await markdownToHast.run(markdownToHast.parse(file), file);
  } else {
    ({ kind, tree, docTitle } = parseHtml(source, report));
  }

  if (options.resolveRef) resolveRefs(tree, options.resolveRef);

  if (kind === 'document') {
    return {
      kind,
      meta: source.meta,
      title: source.meta.title ?? docTitle ?? titleFromPath(source.path),
      lang,
      tree,
      headings: [],
      diagnostics,
    };
  }

  const headingTitle = takeTitleHeading(tree, source.meta.title);
  const title = source.meta.title ?? headingTitle ?? docTitle;
  if (title === undefined) {
    report({
      ruleId: 'page-title',
      severity: 'warning',
      wcag: '2.4.2',
      message: `Page has no title; using "${titleFromPath(source.path)}"`,
      hint: 'Add `title:` to the front-matter, or start the page with a # heading.',
    });
  }

  shiftHeadings(tree, report);
  transformMedia(tree, report, {
    language: lang,
    ...(options.fileExists && { fileExists: options.fileExists }),
  });
  transformNewTabLinks(tree);
  tree = await enhanceFragment.run(tree, file);

  return {
    kind,
    meta: source.meta,
    title: title ?? titleFromPath(source.path),
    lang,
    tree,
    headings: collectHeadings(tree),
    diagnostics,
  };
}
