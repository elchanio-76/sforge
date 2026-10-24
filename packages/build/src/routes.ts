import { posix } from 'node:path';
import type { Element } from 'hast';
import type { Report, ResolveRef } from '@staticforge/content';
import { PAGE_EXTENSIONS, ProjectDirs } from './project.js';

export interface UrlOptions {
  cleanUrls: boolean;
  trailingSlash: 'always' | 'never';
}

export interface Route {
  /** Root-relative URL, e.g. "/blog/hello/". */
  url: string;
  /** Output file, POSIX-relative to the output directory. */
  output: string;
}

/**
 * Map a page's path inside content/ to its URL and output file.
 *
 *   index.md         → /             index.html
 *   about.md         → /about/       about/index.html   (cleanUrls, trailingSlash: always)
 *                    → /about        about.html         (cleanUrls, trailingSlash: never)
 *                    → /about.html   about.html         (cleanUrls: false)
 *   blog/_index.md   → /blog/        blog/index.html
 *   404.md           → /404.html     404.html           (always, for hosting providers)
 */
export function routeFor(
  contentPath: string,
  slug: string | undefined,
  options: UrlOptions,
): Route {
  const segments = contentPath.replace(/\.[^./]+$/, '').split('/');
  let last = segments.pop() ?? 'index';
  const isIndex = last === 'index' || last === '_index';
  if (!isIndex && slug !== undefined) last = slug;

  if (segments.length === 0 && last === '404') return { url: '/404.html', output: '404.html' };

  const path = (isIndex ? segments : [...segments, last]).join('/');
  if (path === '') return { url: '/', output: 'index.html' };

  const encoded = encodeURI(path);
  if (options.cleanUrls && options.trailingSlash === 'never') {
    return { url: `/${encoded}`, output: `${path}.html` };
  }
  if (options.cleanUrls || isIndex) return { url: `/${encoded}/`, output: `${path}/index.html` };
  return { url: `/${encoded}.html`, output: `${path}.html` };
}

const isPage = (path: string): boolean => PAGE_EXTENSIONS.has(posix.extname(path).toLowerCase());

/**
 * Resolve references the way authors write them (relative to the source file,
 * pointing at other sources) to the URLs they have in the built site:
 *
 *   other.md#intro        → /other/#intro            (a page)
 *   photo.jpg             → /blog/photo.jpg          (a file next to the page)
 *   ../../assets/logo.svg → /assets/logo.svg
 *   ../../static/cv.pdf   → /cv.pdf
 *
 * Root-relative URLs are site URLs and stay unchanged, except page sources
 * (e.g. /blog/post.md). Absolute URLs and fragments are untouched.
 */
export function createRefResolver(options: {
  /** Project-relative path of the page holding the references. */
  sourcePath: string;
  /** Page URL by project-relative source path. */
  pageUrls: ReadonlyMap<string, string>;
  report: Report;
}): ResolveRef {
  const { sourcePath, pageUrls, report } = options;
  const contentPrefix = `${ProjectDirs.content}/`;

  return (ref: string, node: Element) => {
    if (
      ref === '' ||
      ref.startsWith('#') ||
      ref.startsWith('//') ||
      /^[a-z][a-z\d+.-]*:/i.test(ref)
    ) {
      return undefined;
    }
    const [, rawPath = '', suffix = ''] = /^([^?#]*)(.*)$/s.exec(ref) ?? [];
    if (rawPath === '') return undefined;

    let path: string;
    try {
      path = decodeURI(rawPath);
    } catch {
      return undefined;
    }

    let projectPath: string;
    if (path.startsWith('/')) {
      if (!isPage(path)) return undefined;
      projectPath = posix.normalize(contentPrefix + path.slice(1));
    } else {
      projectPath = posix.normalize(posix.join(posix.dirname(sourcePath), path));
    }

    const pageUrl = pageUrls.get(projectPath);
    if (pageUrl !== undefined) return pageUrl + suffix;

    if (projectPath.startsWith(contentPrefix)) {
      if (isPage(projectPath)) {
        report(
          {
            ruleId: 'link-broken',
            severity: 'warning',
            message: `Link to ${ref} does not match any page`,
            hint: 'Check the path, or the page may be a draft.',
          },
          node,
        );
        return undefined;
      }
      return `/${encodeURI(projectPath.slice(contentPrefix.length))}${suffix}`;
    }
    if (projectPath.startsWith(`${ProjectDirs.assets}/`))
      return `/${encodeURI(projectPath)}${suffix}`;
    if (projectPath.startsWith(`${ProjectDirs.static}/`)) {
      return `/${encodeURI(projectPath.slice(ProjectDirs.static.length + 1))}${suffix}`;
    }

    report(
      {
        ruleId: 'link-outside-site',
        severity: 'warning',
        message: `Reference ${ref} points outside content/, assets/ and static/, so it will not be published`,
      },
      node,
    );
    return undefined;
  };
}
