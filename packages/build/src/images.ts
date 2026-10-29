import { posix } from 'node:path';
import type { Element, Root } from 'hast';
import { visit } from 'unist-util-visit';
import {
  type ImageOptions,
  OPTIMIZABLE,
  type OptimizedImage,
  optimizeImage,
  srcsetOf,
} from '@staticforge/assets';

/** Where image variants are written in the build. */
const IMAGE_DIR = '_assets/img';

export interface ImageContext extends ImageOptions {
  sizes: string;
  /** Source file of a root-relative URL in the built site, if it is copied from the project. */
  sourceOf: (urlPath: string) => string | undefined;
  /** Called for each variant to write. */
  emit: (output: string, file: string) => void;
  /** Called when an image cannot be processed. */
  fail: (node: Element, message: string) => void;
}

/** Images being processed, by source file, so each is encoded once per build. */
export type ImageCache = Map<string, Promise<OptimizedImage>>;

const stringProperty = (node: Element, name: string): string | undefined => {
  const value = node.properties[name];
  return typeof value === 'string' ? value : undefined;
};

/**
 * Replace content images with responsive `<picture>` elements: modern formats
 * at several widths, the original format as fallback, and width/height so
 * the layout does not shift while images load.
 */
export async function optimizeImages(
  tree: Root,
  context: ImageContext,
  cache: ImageCache,
): Promise<void> {
  const jobs: { node: Element; parent: Element | Root; index: number; source: string }[] = [];
  visit(tree, 'element', (node: Element, index, parent) => {
    if (node.tagName !== 'img' || parent === undefined || index === undefined) return;
    // An author-built <picture> or srcset is left alone.
    if (
      (parent.type === 'element' && parent.tagName === 'picture') ||
      node.properties.srcSet !== undefined
    )
      return;
    const src = stringProperty(node, 'src');
    if (src === undefined || !src.startsWith('/') || src.startsWith('//')) return;
    const path = src.split(/[?#]/)[0] ?? '';
    if (!OPTIMIZABLE.test(path)) return;
    const source = context.sourceOf(path);
    if (source !== undefined) jobs.push({ node, parent, index, source });
  });

  await Promise.all(
    jobs.map(async ({ node, parent, index, source }) => {
      let image = cache.get(source);
      if (image === undefined) {
        const stem = posix
          .basename(source)
          .replace(/\.[^.]+$/, '')
          .replace(/[^\w-]+/g, '-');
        image = optimizeImage(source, `${IMAGE_DIR}/${stem}`, context);
        cache.set(source, image);
      }
      let result: OptimizedImage;
      try {
        result = await image;
      } catch (error) {
        context.fail(
          node,
          (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '',
        );
        return;
      }
      for (const variant of [
        ...result.sources.flatMap((s) => s.variants),
        ...result.fallback.variants,
      ]) {
        context.emit(variant.output, variant.file);
      }

      const urlOf = (output: string) => `/${output}`;
      const largest = result.fallback.variants.at(-1);
      if (largest === undefined) return;
      const img: Element = {
        ...node,
        properties: {
          ...node.properties,
          src: urlOf(largest.output),
          srcSet: srcsetOf(result.fallback.variants, urlOf),
          sizes: context.sizes,
          // Keep the author's size; otherwise reserve the aspect ratio.
          ...(node.properties.width === undefined &&
            node.properties.height === undefined && {
              width: largest.width,
              height: Math.round((result.height * largest.width) / result.width),
            }),
        },
      };
      const picture: Element = {
        type: 'element',
        tagName: 'picture',
        properties: {},
        children: [
          ...result.sources.map((s): Element => ({
            type: 'element',
            tagName: 'source',
            properties: { type: s.type, srcSet: srcsetOf(s.variants, urlOf), sizes: context.sizes },
            children: [],
          })),
          img,
        ],
        ...(node.position && { position: node.position }),
      };
      parent.children[index] = picture;
    }),
  );
}
