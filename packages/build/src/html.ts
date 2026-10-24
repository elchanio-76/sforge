import type { Element, Root } from 'hast';
import { fromHtml } from 'hast-util-from-html';
import { minifyWhitespace } from 'hast-util-minify-whitespace';
import { toHtml } from 'hast-util-to-html';
import { visit } from 'unist-util-visit';

export interface FinishOptions {
  /** Final URL of an asset (its fingerprinted name), or the URL unchanged. */
  assetUrl: (url: string) => string;
  /** Collapse insignificant whitespace (never inside <pre>, <textarea> or inline content). */
  minify: boolean;
}

const URL_PROPERTIES = ['href', 'src'] as const;

/** Rewrite asset references and minify a page's tree in place. */
export function finishTree(tree: Root, options: FinishOptions): void {
  visit(tree, 'element', (node: Element) => {
    for (const name of URL_PROPERTIES) {
      const value = node.properties[name];
      if (typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')) {
        node.properties[name] = options.assetUrl(value);
      }
    }
  });
  if (options.minify) minifyWhitespace(tree);
}

/** The same, for an HTML fragment such as a page body in a feed. */
export function finishFragment(html: string, options: FinishOptions): string {
  const tree = fromHtml(html, { fragment: true });
  finishTree(tree, options);
  return toHtml(tree);
}

/** Rewrite asset references in, and minify, a rendered page. */
export function finishHtml(html: string, options: FinishOptions): string {
  const tree = fromHtml(html);
  finishTree(tree, options);
  return toHtml(tree);
}
