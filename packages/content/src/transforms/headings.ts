import type { Element, Root, RootContent } from 'hast';
import { toString } from 'hast-util-to-string';
import { SKIP, visit } from 'unist-util-visit';
import type { Report } from './report.js';

export interface Heading {
  depth: number;
  id: string | undefined;
  text: string;
}

const headingDepth = (node: Element): number | undefined => {
  const match = /^h([1-6])$/.exec(node.tagName);
  return match ? Number(match[1]) : undefined;
};

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * The layout renders the page title as the only `<h1>`. A leading `<h1>` in the
 * content is that title: use it when the front-matter has none, and drop it
 * when it repeats the front-matter title.
 */
export function takeTitleHeading(tree: Root, metaTitle: string | undefined): string | undefined {
  let found: { node: Element; parent: Root | Element; index: number } | undefined;
  let sawHeading = false;

  visit(tree, 'element', (node: Element, index, parent) => {
    if (sawHeading) return SKIP;
    const depth = headingDepth(node);
    if (depth === undefined) return;
    sawHeading = true;
    if (depth === 1 && parent !== undefined && index !== undefined) {
      found = { node, parent: parent as Root | Element, index };
    }
    return SKIP;
  });

  if (found === undefined) return undefined;
  const text = normalize(toString(found.node));
  if (metaTitle !== undefined && normalize(metaTitle) !== text) return undefined;
  (found.parent.children as RootContent[]).splice(found.index, 1);
  return text === '' ? undefined : text;
}

/** Demote every heading one level if the content still contains an `<h1>`. */
export function shiftHeadings(tree: Root, report: Report): void {
  let firstH1: Element | undefined;
  visit(tree, 'element', (node: Element) => {
    if (firstH1 === undefined && node.tagName === 'h1') firstH1 = node;
  });
  if (firstH1 === undefined) return;

  report(
    {
      ruleId: 'heading-shift',
      severity: 'info',
      message: 'Content headings were demoted one level because the layout provides the <h1>',
      hint: 'Start content headings at level 2 (##), or remove the extra # heading.',
    },
    firstH1,
  );
  visit(tree, 'element', (node: Element) => {
    const depth = headingDepth(node);
    if (depth === undefined) return;
    if (depth === 6) {
      report(
        {
          ruleId: 'heading-depth',
          severity: 'warning',
          message: 'Heading cannot be demoted below <h6>',
        },
        node,
      );
      return;
    }
    node.tagName = `h${depth + 1}`;
  });
}

/** Headings below the page title, in document order (for tables of contents). */
export function collectHeadings(tree: Root): Heading[] {
  const headings: Heading[] = [];
  visit(tree, 'element', (node: Element) => {
    const depth = headingDepth(node);
    if (depth === undefined || depth === 1) return;
    const id = node.properties.id;
    headings.push({
      depth,
      id: typeof id === 'string' ? id : undefined,
      text: normalize(toString(node)),
    });
    return SKIP;
  });
  return headings;
}
