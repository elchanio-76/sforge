import { posix } from 'node:path';
import type { Element, Root as HastRoot } from 'hast';
import { fromHtml } from 'hast-util-from-html';
import { toString as hastToString } from 'hast-util-to-string';
import type { Definition, Heading, Link, Root as MdastRoot, Nodes as MdastNodes } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import { createRefResolver } from '@staticforge/build';
import { type PreparedSource, titleFromPath } from '@staticforge/content';
import type { Diagnostic } from '@staticforge/core';
import { LineIndex, type TextEdit, escapeHtml } from './text.js';
import type { CheckPage, Finding } from './types.js';

export interface SourceContext {
  page: CheckPage & { source: string };
  /** The source file as on disk. */
  text: string;
  prepared: PreparedSource;
  /** Site language, for `lang` fixes. */
  language: string;
  /** Page URL by project-relative source path. */
  pageUrls: ReadonlyMap<string, string>;
  trailingSlash: 'always' | 'never';
}

interface VerbosePosition {
  opening?: { start: { offset?: number }; end: { offset?: number } };
  closing?: { start: { offset?: number }; end: { offset?: number } };
  properties?: Record<string, { start: { offset?: number }; end: { offset?: number } }>;
}

/** An element from the source with offsets into the prepared body. */
interface SourceElement {
  node: Element;
  /** Offset of the HTML snippet the element was parsed from. */
  base: number;
}

const markdownParser = unified().use(remarkParse).use(remarkGfm);

const verbose = (node: Element): VerbosePosition | undefined =>
  (node.data as { position?: VerbosePosition } | undefined)?.position;

/**
 * Source rules re-parse the author's file, so their findings point at exact
 * lines and can carry fixes. They only report what they can locate; the
 * output rules cover everything else (including theme templates).
 */
export function checkSource(ctx: SourceContext): Finding[] {
  const { prepared, text } = ctx;
  const body = prepared.body;
  const bodyIndex = new LineIndex(body);
  const fileIndex = new LineIndex(text);
  // Front-matter is blanked line for line, so body and file share line
  // numbers; only a stripped BOM shifts the first line.
  const bom = text.startsWith('﻿') && !body.startsWith('﻿') ? 1 : 0;
  const toFile = (offset: number): number => {
    const point = bodyIndex.point(offset);
    return fileIndex.offset(point) + (point.line === 1 ? bom : 0);
  };

  const findings: Finding[] = [];
  const report = (
    diagnostic: Omit<Diagnostic, 'file' | 'line' | 'column' | 'url' | 'fixable'>,
    at: number,
    edits: TextEdit[] | undefined,
    match?: string,
  ): void => {
    const point = fileIndex.point(toFile(at));
    findings.push({
      layer: 'source',
      diagnostic: {
        ...diagnostic,
        file: ctx.page.source,
        line: point.line,
        column: point.column,
        url: ctx.page.url,
        fixable: edits !== undefined,
      },
      ...(edits && {
        edits: edits.map((e) => ({ start: toFile(e.start), end: toFile(e.end), text: e.text })),
      }),
      ...(match !== undefined && { match }),
    });
  };

  const elements: SourceElement[] = [];
  let mdast: MdastRoot | undefined;
  if (prepared.format === 'markdown') {
    mdast = markdownParser.parse(body);
    visit(mdast, 'html', (node) => {
      const base = node.position?.start.offset;
      if (base === undefined) return;
      collectElements(fromHtml(node.value, { fragment: true, verbose: true }), base, elements);
    });
  } else {
    const tree = fromHtml(body, { fragment: ctx.page.kind !== 'document', verbose: true });
    collectElements(tree, 0, elements);
    if (ctx.page.kind === 'document') {
      checkHtmlLang(elements, ctx, report);
      checkDocumentTitle(elements, ctx, bodyIndex, report);
    }
  }
  if (mdast !== undefined) checkMarkdownHeadings(mdast, body, prepared, report);
  checkTrailingSlashLinks(mdast, elements, body, ctx, report);
  return findings;
}

type Report = (
  diagnostic: Omit<Diagnostic, 'file' | 'line' | 'column' | 'url' | 'fixable'>,
  at: number,
  edits: TextEdit[] | undefined,
  match?: string,
) => void;

function collectElements(tree: HastRoot, base: number, into: SourceElement[]): void {
  visit(tree, 'element', (node: Element) => {
    into.push({ node, base });
  });
}

const openingOf = (el: SourceElement): { start: number; end: number } | undefined => {
  const opening = verbose(el.node)?.opening;
  if (opening?.start.offset === undefined || opening.end.offset === undefined) return undefined;
  return { start: el.base + opening.start.offset, end: el.base + opening.end.offset };
};

const explicit = (elements: SourceElement[], tagName: string): SourceElement | undefined =>
  elements.find((el) => el.node.tagName === tagName && openingOf(el) !== undefined);

function checkHtmlLang(elements: SourceElement[], ctx: SourceContext, report: Report): void {
  const html = explicit(elements, 'html');
  if (html === undefined) return;
  const lang = html.node.properties.lang;
  if (typeof lang === 'string' && lang.trim() !== '') return;

  const opening = openingOf(html);
  if (opening === undefined) return;
  const attribute = verbose(html.node)?.properties?.lang;
  const replacement = `lang="${escapeHtml(ctx.language)}"`;
  const edit: TextEdit =
    attribute?.start.offset !== undefined && attribute.end.offset !== undefined
      ? {
          start: html.base + attribute.start.offset,
          end: html.base + attribute.end.offset,
          text: replacement,
        }
      : {
          start: opening.start + '<html'.length,
          end: opening.start + '<html'.length,
          text: ` ${replacement}`,
        };
  report(
    {
      ruleId: 'html-lang',
      severity: 'error',
      wcag: '3.1.1',
      message: 'The <html> element has no lang attribute',
      hint: `Add ${replacement} so assistive technology uses the right language.`,
    },
    opening.start,
    [edit],
  );
}

function checkDocumentTitle(
  elements: SourceElement[],
  ctx: SourceContext,
  index: LineIndex,
  report: Report,
): void {
  const title = elements.find((el) => el.node.tagName === 'title');
  if (title !== undefined && hastToString(title.node).trim() !== '') return;

  const h1 = elements.find((el) => el.node.tagName === 'h1');
  const h1Text = h1 === undefined ? '' : hastToString(h1.node).replace(/\s+/g, ' ').trim();
  const text = escapeHtml(h1Text === '' ? titleFromPath(ctx.page.source) : h1Text);
  const diagnostic = {
    ruleId: 'document-title',
    severity: 'error' as const,
    wcag: '2.4.2',
    message: title === undefined ? 'Page has no <title>' : 'Page has an empty <title>',
    hint: 'Give every page a <title> that describes its topic or purpose.',
  };

  const titlePosition = title === undefined ? undefined : verbose(title.node);
  if (title !== undefined) {
    const start = titlePosition?.opening?.end.offset;
    const end = titlePosition?.closing?.start.offset;
    const opening = openingOf(title);
    if (opening === undefined) return;
    report(
      diagnostic,
      opening.start,
      start === undefined || end === undefined
        ? undefined
        : [{ start: title.base + start, end: title.base + end, text }],
    );
    return;
  }

  // Insert at the top of <head>, or straight after <html> when <head> is implied.
  const parent = explicit(elements, 'head') ?? explicit(elements, 'html');
  const opening = parent === undefined ? undefined : openingOf(parent);
  if (opening === undefined) {
    report(diagnostic, 0, undefined);
    return;
  }
  // After leading <meta> elements: the charset declaration must come first.
  let at = opening.end;
  let indent = `${index.indentAt(opening.start)}  `;
  if (parent?.node.tagName === 'head') {
    for (const child of parent.node.children) {
      if (child.type === 'text' && child.value.trim() === '') continue;
      if (child.type !== 'element' || child.tagName !== 'meta') break;
      const meta = openingOf({ node: child, base: parent.base });
      if (meta === undefined) break;
      at = meta.end;
      indent = index.indentAt(meta.start);
    }
  }
  report(diagnostic, opening.start, [
    { start: at, end: at, text: `\n${indent}<title>${text}</title>` },
  ]);
}

/**
 * Mirror the build: a leading `# Title` becomes the layout's <h1>, and other
 * `#` headings are demoted. Then no heading may skip a level below its
 * predecessor. ATX headings (`###`) are fixed by changing the `#` count.
 */
function checkMarkdownHeadings(
  tree: MdastRoot,
  body: string,
  prepared: PreparedSource,
  report: Report,
): void {
  const headings: Heading[] = [];
  visit(tree, 'heading', (node) => {
    headings.push(node);
  });
  if (headings.length === 0) return;

  const normalize = (s: string): string => s.replace(/\s+/g, ' ').trim();
  const first = headings[0];
  const metaTitle = prepared.meta.title;
  const rest =
    first?.depth === 1 &&
    (metaTitle === undefined || normalize(metaTitle) === normalize(mdText(first)))
      ? headings.slice(1)
      : headings;
  const shift = rest.some((h) => h.depth === 1) ? 1 : 0;

  let previous = 1;
  for (const heading of rest) {
    const depth = Math.min(heading.depth + shift, 6);
    if (depth <= previous + 1) {
      previous = depth;
      continue;
    }
    const target = previous + 1;
    const start = heading.position?.start.offset;
    if (start === undefined) continue;
    const hashes = /^ {0,3}(#{1,6})(?=[ \t]|$)/.exec(body.slice(start));
    const marker = hashes?.[1];
    const edits =
      marker === undefined
        ? undefined
        : [
            {
              start: start + (hashes?.[0].length ?? 0) - marker.length,
              end: start + (hashes?.[0].length ?? 0),
              text: '#'.repeat(target - shift),
            },
          ];
    report(
      {
        ruleId: 'heading-order',
        severity: 'warning',
        wcag: '1.3.1',
        message: `Heading level skips from h${previous} to h${depth}`,
        hint: `Use an h${target} here (${'#'.repeat(target - shift)}), so the outline has no gaps.`,
      },
      start,
      edits,
    );
    previous = target;
  }
}

const mdText = (node: MdastNodes): string => {
  if ('value' in node && typeof node.value === 'string') return node.value;
  if ('children' in node) return node.children.map(mdText).join('');
  return '';
};

interface RefOccurrence {
  value: string;
  /** Offsets of `value` in the body, when it appears there verbatim. */
  range: { start: number; end: number } | undefined;
  at: number;
}

const EXTERNAL = /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i;

/**
 * Links that resolve to a page except for the trailing slash cost a redirect
 * on every click (`/about` → 301 `/about/`). Rewrite them to the canonical URL.
 */
function checkTrailingSlashLinks(
  mdast: MdastRoot | undefined,
  elements: SourceElement[],
  body: string,
  ctx: SourceContext,
  report: Report,
): void {
  const refs: RefOccurrence[] = [];
  if (mdast !== undefined) {
    visit(mdast, (node) => {
      if (node.type !== 'link' && node.type !== 'definition') return;
      const { url, position } = node as Link | Definition;
      const start = position?.start.offset;
      const end = position?.end.offset;
      if (start === undefined || end === undefined) return;
      // The URL follows the link text (or the definition label).
      const after =
        node.type === 'link'
          ? ((node as Link).children.at(-1)?.position?.end.offset ?? start)
          : start + body.slice(start, end).indexOf(']:');
      const found = body.indexOf(url, after);
      refs.push({
        value: url,
        range:
          found !== -1 && found + url.length <= end
            ? { start: found, end: found + url.length }
            : undefined,
        at: start,
      });
    });
  }
  for (const el of elements) {
    const href = el.node.properties.href;
    if (el.node.tagName !== 'a' || typeof href !== 'string') continue;
    const attribute = verbose(el.node)?.properties?.href;
    const start = attribute?.start.offset;
    const end = attribute?.end.offset;
    const opening = openingOf(el);
    if (opening === undefined) continue;
    let range: RefOccurrence['range'];
    if (start !== undefined && end !== undefined) {
      const raw = body.slice(el.base + start, el.base + end);
      const at = raw.indexOf(href, raw.indexOf('=') + 1);
      if (at !== -1)
        range = { start: el.base + start + at, end: el.base + start + at + href.length };
    }
    refs.push({ value: href, range, at: opening.start });
  }
  if (refs.length === 0) return;

  const resolve = createRefResolver({
    sourcePath: ctx.page.source,
    pageUrls: ctx.pageUrls,
    report: () => undefined,
  });
  const urls = new Set(ctx.pageUrls.values());
  const placeholder: Element = { type: 'element', tagName: 'a', properties: {}, children: [] };

  for (const ref of refs) {
    if (ref.value === '' || EXTERNAL.test(ref.value)) continue;
    const [, path = '', suffix = ''] = /^([^?#]*)(.*)$/s.exec(ref.value) ?? [];
    if (path === '' || /\.(?:md|markdown)$/i.test(path)) continue;

    const pathname = (value: string): string =>
      new URL(resolve(value, placeholder) ?? value, `http://site.invalid${ctx.page.url}`).pathname;
    const current = pathname(path);
    if (urls.has(current) || current === '/') continue;

    let fixed: string | undefined;
    if (ctx.trailingSlash === 'always' && !current.endsWith('/') && urls.has(`${current}/`)) {
      fixed = `${path}/`;
    } else if (
      ctx.trailingSlash === 'never' &&
      current.endsWith('/') &&
      urls.has(current.slice(0, -1)) &&
      path.endsWith('/')
    ) {
      fixed = path.slice(0, -1);
    }
    if (fixed === undefined) continue;

    report(
      {
        ruleId: 'link-trailing-slash',
        severity: 'warning',
        message: `Link to ${ref.value} redirects to ${pathname(fixed)}${suffix}`,
        hint: "Link to the page's canonical URL to save a redirect.",
      },
      ref.at,
      ref.range === undefined
        ? undefined
        : [{ start: ref.range.start, end: ref.range.end, text: fixed + suffix }],
      current,
    );
  }
}

/** Page URL by project-relative source path, as the build assigned them. */
export function pageUrlMap(pages: CheckPage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const page of pages) {
    if (page.source !== undefined) map.set(posix.normalize(page.source), page.url);
  }
  return map;
}
