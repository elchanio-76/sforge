export type Resolution =
  | { kind: 'file'; path: string; status: 200 | 404 }
  | { kind: 'redirect'; location: string }
  | { kind: 'not-found' };

export interface ResolveOptions {
  trailingSlash: 'always' | 'never';
}

/**
 * Map a request path to a file in the built site, the way the hosting
 * providers are configured to (see the CloudFront function in M5):
 *
 *   /                → index.html
 *   /about/          → about/index.html
 *   /about           → 301 /about/       if about/index.html exists (trailingSlash: always)
 *                    → about.html        if it exists (trailingSlash: never)
 *   /about/          → 301 /about        if only about.html exists (trailingSlash: never)
 *   /style.css       → style.css
 *   anything else    → 404.html with status 404, if the site has one
 *
 * Dot-files and dot-directories (e.g. .sforge/) are never served.
 *
 * @param pathname URL-encoded path from the request line, without the query.
 * @param exists   Whether a POSIX path relative to the site root is a file.
 */
export function resolveRequest(
  pathname: string,
  exists: (path: string) => boolean,
  options: ResolveOptions,
): Resolution {
  const notFound = (): Resolution =>
    exists('404.html') ? { kind: 'file', path: '404.html', status: 404 } : { kind: 'not-found' };

  if (!pathname.startsWith('/')) return notFound();
  let segments: string[];
  try {
    segments = pathname.slice(1).split('/').map(decodeURIComponent);
  } catch {
    return notFound();
  }
  const trailing = segments.at(-1) === '';
  if (trailing) segments.pop();
  if (segments.some((s) => s === '' || s.startsWith('.') || /[\\\0]/.test(s))) return notFound();

  const path = segments.join('/');
  if (trailing || path === '') {
    const index = path === '' ? 'index.html' : `${path}/index.html`;
    if (exists(index)) return { kind: 'file', path: index, status: 200 };
    if (options.trailingSlash === 'never' && path !== '' && exists(`${path}.html`)) {
      return { kind: 'redirect', location: pathname.replace(/\/$/, '') };
    }
    return notFound();
  }

  if (exists(path)) return { kind: 'file', path, status: 200 };
  if (exists(`${path}/index.html`)) return { kind: 'redirect', location: `${pathname}/` };
  if (exists(`${path}.html`)) return { kind: 'file', path: `${path}.html`, status: 200 };
  return notFound();
}
