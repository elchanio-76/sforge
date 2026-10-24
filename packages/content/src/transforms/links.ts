import type { Element, Root } from 'hast';
import { h } from 'hastscript';
import { toString } from 'hast-util-to-string';
import { visit } from 'unist-util-visit';

/**
 * Links that open a new tab get `rel="noopener noreferrer"` and visually hidden
 * text announcing the new tab (WCAG 3.2.5 advisory; prevents reverse tabnabbing).
 * Themes must style the `visually-hidden` class.
 */
export function transformNewTabLinks(tree: Root): void {
  visit(tree, 'element', (node: Element) => {
    if (node.tagName !== 'a' || node.properties.target !== '_blank') return;

    const rel = new Set(Array.isArray(node.properties.rel) ? node.properties.rel.map(String) : []);
    rel.add('noopener');
    rel.add('noreferrer');
    node.properties.rel = [...rel];

    if (!/new (tab|window)/i.test(toString(node))) {
      node.children.push(h('span.visually-hidden', ' (opens in a new tab)'));
    }
  });
}
