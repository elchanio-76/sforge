import type { Element, Root, RootContent } from 'hast';
import { toString as hastToString } from 'hast-util-to-string';
import type { Diagnostic } from '@staticforge/core';
import { resolveRequest } from '@staticforge/server';
import type { CheckPage, Finding } from './types.js';

export interface OutputContext {
  page: CheckPage;
  /** The built page, parsed. */
  tree: Root;
  /** Whether a POSIX path relative to the build directory is a file. */
  exists: (path: string) => boolean;
  /** Element ids of a built HTML file, by output path. */
  idsOf: (output: string) => ReadonlySet<string> | undefined;
  trailingSlash: 'always' | 'never';
}

interface Visit {
  node: Element;
  ancestors: Element[];
}

/** Every element with its ancestors, in document order. */
export function elementsOf(tree: Root): Visit[] {
  const out: Visit[] = [];
  const walk = (children: RootContent[], ancestors: Element[]): void => {
    for (const child of children) {
      if (child.type !== 'element') continue;
      out.push({ node: child, ancestors });
      walk(child.children, [...ancestors, child]);
      if (child.tagName === 'template' && child.content)
        walk(child.content.children, [...ancestors, child]);
    }
  };
  walk(tree.children, []);
  return out;
}

/** Element ids (and legacy `<a name>` anchors) of a parsed page. */
export function idsOf(tree: Root): Set<string> {
  const ids = new Set<string>();
  for (const { node } of elementsOf(tree)) {
    const id = node.properties.id;
    if (typeof id === 'string' && id !== '') ids.add(id);
    const name = node.properties.name;
    if (node.tagName === 'a' && typeof name === 'string' && name !== '') ids.add(name);
  }
  return ids;
}

/** A short CSS path like `#main > article > p:nth-child(3) > img`. */
export function selectorOf({ node, ancestors }: Visit): string {
  const parts: string[] = [];
  const chain = [...ancestors, node];
  for (let i = chain.length - 1; i >= 0; i--) {
    const el = chain[i] as Element;
    const id = el.properties.id;
    if (typeof id === 'string' && /^[A-Za-z][\w-]*$/.test(id)) {
      parts.unshift(`#${id}`);
      break;
    }
    const parent = chain[i - 1];
    const siblings = parent?.children.filter((c): c is Element => c.type === 'element') ?? [];
    const sameTag = siblings.filter((s) => s.tagName === el.tagName);
    parts.unshift(
      sameTag.length > 1 ? `${el.tagName}:nth-child(${siblings.indexOf(el) + 1})` : el.tagName,
    );
  }
  return parts.join(' > ');
}

const text = (node: Element): string => hastToString(node).replace(/\s+/g, ' ').trim();
const attr = (node: Element, name: string): string | undefined => {
  const value = node.properties[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.join(' ');
  return undefined;
};

const URL_ATTRIBUTES: Record<string, string[]> = {
  a: ['href'],
  area: ['href'],
  link: ['href'],
  script: ['src'],
  img: ['src', 'srcSet'],
  source: ['src', 'srcSet'],
  video: ['src', 'poster'],
  audio: ['src'],
  track: ['src'],
  iframe: ['src'],
  embed: ['src'],
};

const SCHEME = /^[a-z][a-z\d+.-]*:/i;

export function checkOutput(ctx: OutputContext): Finding[] {
  const { page, tree } = ctx;
  const findings: Finding[] = [];
  const all = elementsOf(tree);
  const report = (
    diagnostic: Omit<Diagnostic, 'file' | 'url' | 'selector'>,
    at?: Visit,
    match?: string,
  ): void => {
    findings.push({
      layer: 'output',
      diagnostic: {
        ...diagnostic,
        ...(page.source !== undefined && { file: page.source }),
        url: page.url,
        ...(at && { selector: selectorOf(at) }),
      },
      ...(match !== undefined && { match }),
    });
  };
  const find = (tagName: string): Visit | undefined => all.find((v) => v.node.tagName === tagName);

  // html-lang
  const html = find('html');
  if (html !== undefined && (attr(html.node, 'lang') ?? '').trim() === '') {
    report(
      {
        ruleId: 'html-lang',
        severity: 'error',
        wcag: '3.1.1',
        message: 'The <html> element has no lang attribute',
        hint: 'Set lang on <html> in the layout (or the document), e.g. lang="en".',
      },
      html,
    );
  }

  // document-title
  const title = find('title');
  if (title === undefined || text(title.node) === '') {
    report(
      {
        ruleId: 'document-title',
        severity: 'error',
        wcag: '2.4.2',
        message: title === undefined ? 'Page has no <title>' : 'Page has an empty <title>',
      },
      title ?? html,
    );
  }

  // meta-viewport
  const viewport = all.find(
    (v) => v.node.tagName === 'meta' && attr(v.node, 'name') === 'viewport',
  );
  if (viewport === undefined) {
    report({
      ruleId: 'meta-viewport',
      severity: 'warning',
      wcag: '1.4.10',
      message: 'Page has no <meta name="viewport">, so it will not reflow on small screens',
      hint: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.',
    });
  } else {
    const content = (attr(viewport.node, 'content') ?? '').toLowerCase();
    const scalable = /user-scalable\s*=\s*(no|0)\b/.exec(content);
    const maxScale = /maximum-scale\s*=\s*([\d.]+)/.exec(content);
    if (scalable !== null || (maxScale?.[1] !== undefined && Number(maxScale[1]) < 2)) {
      report(
        {
          ruleId: 'meta-viewport',
          severity: 'error',
          wcag: '1.4.4',
          message: 'The viewport meta tag prevents zooming',
          hint: 'Remove user-scalable=no and any maximum-scale below 2.',
        },
        viewport,
      );
    }
  }

  // landmark-main
  const main = all.find((v) => v.node.tagName === 'main' || attr(v.node, 'role') === 'main');
  if (main === undefined) {
    report({
      ruleId: 'landmark-main',
      severity: 'warning',
      wcag: '1.3.1',
      message: 'Page has no <main> landmark',
      hint: 'Wrap the primary content in <main id="main">.',
    });
  }

  // skip-link: pages with repeated blocks (header/nav) need a way past them.
  const body = find('body');
  const hasBlocks = all.some((v) => v.node.tagName === 'nav' || v.node.tagName === 'header');
  if (body !== undefined && hasBlocks) {
    const firstLink = all.find((v) => v.node.tagName === 'a' && attr(v.node, 'href') !== undefined);
    const href = firstLink === undefined ? undefined : attr(firstLink.node, 'href');
    const target = href?.startsWith('#') ? safeDecode(href.slice(1)) : undefined;
    const ids = idsOf(tree);
    if (target === undefined || target === '' || !ids.has(target)) {
      report(
        {
          ruleId: 'skip-link',
          severity: 'warning',
          wcag: '2.4.1',
          message: 'The first link on the page is not a skip link to the main content',
          hint: 'Start <body> with <a class="skip-link" href="#main">Skip to content</a>.',
        },
        firstLink,
      );
    }
  }

  for (const visit of all) {
    const { node } = visit;
    // video-captions
    if (node.tagName === 'video') {
      const hasCaptions = node.children.some(
        (c) =>
          c.type === 'element' &&
          c.tagName === 'track' &&
          ['captions', 'subtitles'].includes(attr(c, 'kind') ?? ''),
      );
      if (!hasCaptions) {
        report(
          {
            ruleId: 'video-captions',
            severity: 'warning',
            wcag: '1.2.2',
            message: 'Video has no captions track',
            hint: 'Add <track kind="captions" src="…vtt" srclang="en">, unless the video has no speech.',
          },
          visit,
        );
      }
    }
    // iframe-title
    if (
      node.tagName === 'iframe' &&
      (attr(node, 'title') ?? '').trim() === '' &&
      String(node.properties.ariaHidden) !== 'true'
    ) {
      report(
        {
          ruleId: 'iframe-title',
          severity: 'error',
          wcag: '4.1.2',
          message: '<iframe> has no title describing its content',
        },
        visit,
      );
    }
    checkUrls(visit, ctx, report);
  }

  return findings;
}

const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

function checkUrls(
  visit: Visit,
  ctx: OutputContext,
  report: (d: Omit<Diagnostic, 'file' | 'url' | 'selector'>, at?: Visit, key?: string) => void,
): void {
  const { node } = visit;
  for (const name of URL_ATTRIBUTES[node.tagName] ?? []) {
    const raw = node.properties[name];
    if (typeof raw !== 'string' && !Array.isArray(raw)) continue;
    const values =
      name === 'srcSet'
        ? String(Array.isArray(raw) ? raw.join(',') : raw)
            .split(',')
            .map((candidate) => candidate.trim().split(/\s+/)[0] ?? '')
        : [String(Array.isArray(raw) ? raw.join(' ') : raw)];

    for (const value of values) {
      if (value === '' || SCHEME.test(value) || value.startsWith('//')) continue;
      const url = new URL(value, `http://site.invalid${ctx.page.url}`);
      const isLink = node.tagName === 'a' || node.tagName === 'area';
      // Unresolved page sources (e.g. other.md) are reported by the build.
      if (/\.(?:md|markdown)$/i.test(url.pathname)) continue;

      const resolution = resolveRequest(url.pathname, ctx.exists, {
        trailingSlash: ctx.trailingSlash,
      });
      if (resolution.kind === 'redirect') {
        report(
          {
            ruleId: 'link-trailing-slash',
            severity: 'warning',
            message: `Link to ${value} redirects to ${resolution.location}`,
            hint: "Link to the page's canonical URL to save a redirect.",
          },
          visit,
          url.pathname,
        );
        continue;
      }
      if (resolution.kind === 'not-found' || resolution.status === 404) {
        report(
          {
            ruleId: 'link-broken',
            severity: 'error',
            message: isLink
              ? `Link to ${value} does not match any page or file in the built site`
              : `<${node.tagName}> ${name.toLowerCase()} ${value} does not exist in the built site`,
          },
          visit,
          url.pathname,
        );
        continue;
      }

      const fragment = safeDecode(url.hash.slice(1));
      if (
        !isLink ||
        fragment === '' ||
        fragment.toLowerCase() === 'top' ||
        fragment.startsWith(':~:')
      ) {
        continue;
      }
      const ids = ctx.idsOf(resolution.path);
      if (ids !== undefined && !ids.has(fragment)) {
        report(
          {
            ruleId: 'link-fragment',
            severity: 'warning',
            message: `Link to ${value} points to #${fragment}, which is not an id on that page`,
            hint: 'Check the heading or element id; heading ids are derived from their text.',
          },
          visit,
        );
      }
    }
  }
}
