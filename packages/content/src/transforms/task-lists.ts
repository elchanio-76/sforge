import type { Element, ElementContent, Root } from 'hast';
import { visit } from 'unist-util-visit';

const BLOCK = new Set(['ul', 'ol', 'p', 'div', 'pre', 'blockquote', 'table', 'figure']);

const isCheckbox = (node: ElementContent): node is Element =>
  node.type === 'element' && node.tagName === 'input' && node.properties.type === 'checkbox';

/**
 * GFM task list items render as `<li><input type="checkbox" disabled> text</li>`,
 * leaving the checkbox without an accessible name. Wrap it and the item's text
 * in a `<label>` so screen readers announce "Write docs, checkbox, checked".
 */
export function labelTaskListItems(tree: Root): void {
  visit(tree, 'element', (node: Element) => {
    if (node.tagName !== 'li' && node.tagName !== 'p') return;
    const first = node.children.findIndex((child) => child.type !== 'text' || child.value.trim());
    const checkbox = node.children[first];
    if (checkbox === undefined || !isCheckbox(checkbox)) return;

    let end = first + 1;
    while (end < node.children.length) {
      const child = node.children[end];
      if (child?.type === 'element' && BLOCK.has(child.tagName)) break;
      end++;
    }
    const children = node.children.slice(first, end);
    // Keep the newline before a nested list outside the label.
    const after: ElementContent[] = [];
    const last = children.at(-1);
    if (last?.type === 'text') {
      const trimmed = last.value.trimEnd();
      if (trimmed !== last.value) {
        after.push({ type: 'text', value: last.value.slice(trimmed.length) });
        children[children.length - 1] = { ...last, value: trimmed };
      }
    }
    const label: Element = { type: 'element', tagName: 'label', properties: {}, children };
    node.children.splice(first, end - first, label, ...after);
  });
}
