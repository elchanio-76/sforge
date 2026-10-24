import { createReadStream, readFileSync, realpathSync, statSync } from 'node:fs';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { isAbsolute, join, relative, sep } from 'node:path';
import mime from 'mime';
import { ErrorCode, SforgeError } from '@staticforge/core';
import { resolveRequest } from './resolve.js';

export interface StaticServerOptions {
  /** Directory to serve; a function so the dev server can swap builds atomically. */
  root: () => string;
  host: string;
  /** 0 picks a free port. */
  port: number;
  trailingSlash: 'always' | 'never';
  /** Rewrite HTML responses, e.g. to inject the live-reload client. */
  transformHtml?: (html: string) => string;
  /** Handle extra routes first; return true when the request was handled. */
  handle?: (req: IncomingMessage, res: ServerResponse) => boolean;
  cacheControl?: string;
}

export interface StaticServer {
  /** Base URL, e.g. http://127.0.0.1:4321 */
  url: string;
  host: string;
  port: number;
  close(): Promise<void>;
}

const TEXT_TYPES = /^(text\/|application\/(javascript|json|xml|manifest\+json)|image\/svg\+xml)/;

function contentType(path: string): string {
  const type = mime.getType(path) ?? 'application/octet-stream';
  return TEXT_TYPES.test(type) ? `${type}; charset=utf-8` : type;
}

/** Parse a single `bytes=start-end` range; undefined if absent, null if unsatisfiable. */
function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null | undefined {
  if (header === undefined) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return undefined; // multi-range or malformed: serve the whole file
  const [, from = '', to = ''] = match;
  if (from === '' && to === '') return null;
  let start: number;
  let end: number;
  if (from === '') {
    start = Math.max(size - Number(to), 0);
    end = size - 1;
  } else {
    start = Number(from);
    end = to === '' ? size - 1 : Math.min(Number(to), size - 1);
  }
  return start > end || start >= size ? null : { start, end };
}

export function displayUrl(host: string, port: number): string {
  const shown =
    host === '0.0.0.0' || host === '::' ? 'localhost' : host.includes(':') ? `[${host}]` : host;
  return `http://${shown}:${port}`;
}

/** Serve a built site with production URL semantics (see resolveRequest). */
export async function startStaticServer(options: StaticServerOptions): Promise<StaticServer> {
  const cacheControl = options.cacheControl ?? 'no-cache';

  const serve = (req: IncomingMessage, res: ServerResponse) => {
    if (options.handle?.(req, res)) return;

    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res
        .writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' })
        .end('Method Not Allowed\n');
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    let root: string;
    try {
      root = realpathSync(options.root());
    } catch {
      res
        .writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
        .end('Site is not built yet\n');
      return;
    }

    const isFile = (path: string): boolean => {
      try {
        const real = realpathSync(join(root, path));
        // Refuse symlinks that lead outside the site.
        const rel = relative(root, real);
        if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
        return statSync(real).isFile();
      } catch {
        return false;
      }
    };

    const resolution = resolveRequest(url.pathname, isFile, {
      trailingSlash: options.trailingSlash,
    });
    if (resolution.kind === 'redirect') {
      res
        .writeHead(301, {
          Location: resolution.location + url.search,
          'Cache-Control': cacheControl,
        })
        .end();
      return;
    }
    if (resolution.kind === 'not-found') {
      res
        .writeHead(404, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': cacheControl,
        })
        .end('Not Found\n');
      return;
    }

    const file = join(root, resolution.path);
    const type = contentType(file);
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', cacheControl);

    if (options.transformHtml !== undefined && type.startsWith('text/html')) {
      const body = Buffer.from(options.transformHtml(readFileSync(file, 'utf8')));
      res.writeHead(resolution.status, { 'Content-Length': body.length });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }

    const { size } = statSync(file);
    res.setHeader('Accept-Ranges', 'bytes');
    const range = resolution.status === 200 ? parseRange(req.headers.range, size) : undefined;
    if (range === null) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
      return;
    }
    if (range !== undefined) {
      res.writeHead(206, {
        'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
        'Content-Length': range.end - range.start + 1,
      });
    } else {
      res.writeHead(resolution.status, { 'Content-Length': size });
    }
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(file, range ?? {})
      .on('error', () => res.destroy())
      .pipe(res);
  };

  const server: Server = createServer((req, res) => {
    try {
      serve(req, res);
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Internal error: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'EADDRINUSE'
          ? new SforgeError(
              ErrorCode.PortInUse,
              `Port ${options.port} on ${options.host} is already in use`,
              {
                hint: 'Pass --port <n> to use another port, or --port 0 to pick a free one.',
              },
            )
          : error,
      );
    });
    server.listen(options.port, options.host, () => resolve());
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;
  return {
    url: displayUrl(options.host, port),
    host: options.host,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
