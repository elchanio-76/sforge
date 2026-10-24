import type { Element, ElementContent, Root } from 'hast';
import { h } from 'hastscript';
import { visit } from 'unist-util-visit';
import type { Report } from './report.js';

const VIDEO_EXTENSION = /\.(mp4|m4v|webm|ogv|mov)(?=[?#]|$)/i;

export interface MediaOptions {
  /** Page language, used for caption tracks. */
  language: string;
  /** Whether a root-relative URL path will exist in the built site. */
  fileExists?: (urlPath: string) => boolean;
}

const stringProperty = (node: Element, name: string): string | undefined => {
  const value = node.properties[name];
  return typeof value === 'string' ? value : undefined;
};

/**
 * Markdown has no video syntax, so `![Caption](clip.mp4)` produces an `<img>`
 * pointing at a video. Turn those into `<video>` elements.
 */
function imagesToVideos(tree: Root): void {
  visit(tree, 'element', (node: Element, index, parent) => {
    if (node.tagName !== 'img' || parent === undefined || index === undefined) return;
    const src = stringProperty(node, 'src');
    if (src === undefined || !VIDEO_EXTENSION.test(src)) return;

    const caption = stringProperty(node, 'alt')?.trim() ?? '';
    const video = h('video', { src, controls: true, preload: 'metadata' }, [
      h('a', { href: src }, 'Download the video'),
    ]);
    video.position = node.position;
    const replacement = caption === '' ? video : h('figure', [video, h('figcaption', caption)]);
    parent.children[index] = replacement;
  });
}

function checkImages(tree: Root, report: Report): void {
  visit(tree, 'element', (node: Element) => {
    if (node.tagName !== 'img') return;
    node.properties.loading ??= 'lazy';
    node.properties.decoding ??= 'async';

    const alt = stringProperty(node, 'alt');
    const role = stringProperty(node, 'role');
    const hidden = String(node.properties.ariaHidden) === 'true';
    if (alt === undefined && !hidden) {
      report(
        {
          ruleId: 'img-alt',
          severity: 'error',
          wcag: '1.1.1',
          message: 'Image has no alt attribute',
          hint: 'Describe the image in alt text, or use alt="" if it is purely decorative.',
        },
        node,
      );
    } else if (alt?.trim() === '' && role !== 'presentation' && role !== 'none' && !hidden) {
      report(
        {
          ruleId: 'img-alt',
          severity: 'warning',
          wcag: '1.1.1',
          message: 'Image has empty alt text, so screen readers will skip it',
          hint: 'Describe the image, e.g. ![A red bicycle](bike.jpg), or add role="presentation" if it is decorative.',
        },
        node,
      );
    }
  });
}

function captionUrlFor(src: string): string {
  const [path = '', suffix = ''] = src.split(/(?=[?#])/, 2);
  return path.replace(VIDEO_EXTENSION, '.vtt') + suffix.replace(/^\?[^#]*/, '');
}

function checkVideos(tree: Root, report: Report, options: MediaOptions): void {
  visit(tree, 'element', (node: Element) => {
    if (node.tagName !== 'video') return;
    const children = node.children.filter((c): c is Element => c.type === 'element');

    if (node.properties.autoPlay !== undefined && node.properties.controls === undefined) {
      report(
        {
          ruleId: 'video-controls',
          severity: 'warning',
          wcag: '2.2.2',
          message: 'Autoplaying video has no controls to pause it',
        },
        node,
      );
    }

    const hasCaptions = children.some(
      (c) => c.tagName === 'track' && ['captions', 'subtitles'].includes(String(c.properties.kind)),
    );
    if (hasCaptions) return;

    const src =
      stringProperty(node, 'src') ??
      children
        .map((c) => (c.tagName === 'source' ? stringProperty(c, 'src') : undefined))
        .find(Boolean);
    const captions =
      src !== undefined && VIDEO_EXTENSION.test(src) ? captionUrlFor(src) : undefined;

    if (captions !== undefined && options.fileExists?.(captions.split('#')[0] ?? captions)) {
      const track: ElementContent = h('track', {
        kind: 'captions',
        src: captions,
        srcLang: options.language,
        label: 'Captions',
        default: true,
      });
      node.children.unshift(track);
      return;
    }

    report(
      {
        ruleId: 'video-captions',
        severity: 'warning',
        wcag: '1.2.2',
        message: 'Video has no captions track',
        hint:
          captions !== undefined
            ? `Add a WebVTT file at ${captions.split('#')[0]} and it will be linked automatically.`
            : 'Add a <track kind="captions"> element.',
      },
      node,
    );
  });
}

export function transformMedia(tree: Root, report: Report, options: MediaOptions): void {
  imagesToVideos(tree);
  checkImages(tree, report);
  checkVideos(tree, report, options);
}
