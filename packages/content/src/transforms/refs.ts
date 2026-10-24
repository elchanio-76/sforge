import type { Element, Root } from 'hast';
import { visit } from 'unist-util-visit';

/**
 * Rewrites one URL reference; returns undefined to leave it unchanged. `node`
 * is the element holding the reference, for diagnostics positions.
 */
export type ResolveRef = (ref: string, node: Element) => string | undefined;

/** hast property names that hold a URL, per element. */
const urlProperties: Record<string, string[]> = {
  a: ['href'],
  area: ['href'],
  audio: ['src'],
  embed: ['src'],
  iframe: ['src'],
  img: ['src', 'srcSet'],
  link: ['href'],
  object: ['data'],
  script: ['src'],
  source: ['src', 'srcSet'],
  track: ['src'],
  video: ['src', 'poster'],
};

function rewriteSrcset(value: string, node: Element, resolve: ResolveRef): string {
  return value
    .split(',')
    .map((candidate) => {
      const [url = '', ...descriptor] = candidate.trim().split(/\s+/);
      return [resolve(url, node) ?? url, ...descriptor].join(' ');
    })
    .join(', ');
}

/** Apply `resolve` to every URL-valued attribute in the tree. */
export function resolveRefs(tree: Root, resolve: ResolveRef): void {
  visit(tree, 'element', (node: Element) => {
    for (const property of urlProperties[node.tagName] ?? []) {
      const value = node.properties[property];
      if (typeof value !== 'string' || value === '') continue;
      const next =
        property === 'srcSet' ? rewriteSrcset(value, node, resolve) : resolve(value, node);
      if (next !== undefined) node.properties[property] = next;
    }
  });
}
