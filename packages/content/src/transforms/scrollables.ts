import type { Element, Root } from 'hast';
import { toString } from 'hast-util-to-string';
import { SKIP, visit } from 'unist-util-visit';

/** Class of the element tables are wrapped in, which the theme lets scroll sideways. */
export const TABLE_SCROLL_CLASS = 'table-scroll';

const hasClass = (node: Element, name: string): boolean => {
  const classes = node.properties.className;
  return Array.isArray(classes) && classes.includes(name);
};

/**
 * Wide code blocks and tables scroll sideways, and keyboard users can only
 * scroll what they can focus (WCAG 2.1.1). Code blocks get `tabindex="0"`
 * (Shiki adds it to the blocks it highlights); tables are wrapped in a
 * focusable scroll container, so the table keeps its table semantics. The
 * container is a named region when the table has a caption.
 */
export function makeScrollablesFocusable(tree: Root): void {
  visit(tree, 'element', (node: Element, index, parent) => {
    // Shiki sets `tabindex` as a raw attribute name rather than hast's `tabIndex`.
    if (
      node.tagName === 'pre' &&
      node.properties.tabIndex === undefined &&
      node.properties.tabindex === undefined
    ) {
      node.properties.tabIndex = 0;
      return SKIP;
    }
    if (node.tagName !== 'table' || parent === undefined || index === undefined) return;
    if (parent.type === 'element' && hasClass(parent, TABLE_SCROLL_CLASS)) return SKIP;
    const caption = node.children.find(
      (child): child is Element => child.type === 'element' && child.tagName === 'caption',
    );
    const label = caption === undefined ? '' : toString(caption).trim();
    parent.children[index] = {
      type: 'element',
      tagName: 'div',
      properties: {
        className: [TABLE_SCROLL_CLASS],
        tabIndex: 0,
        ...(label !== '' && { role: 'region', ariaLabel: label }),
      },
      children: [node],
    };
    return SKIP;
  });
}
