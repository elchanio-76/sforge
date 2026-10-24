import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveRequest } from '@staticforge/server';
import { SITE_MODULE_DIR, type TrailingSlash, routeExceptions } from '../src/index.js';

interface Config {
  trailingSlash: TrailingSlash;
  previewSuffix: string;
}

interface FunctionResponse {
  statusCode?: number;
  headers?: Record<string, { value: string }>;
  uri?: string;
}

type Handler = (event: unknown) => Promise<FunctionResponse>;

/** Load router.js as CloudFront would, with a fake `cloudfront` module and KVS. */
function loadRouter(config: Config, kvs: Map<string, string>): Handler {
  const source = readFileSync(join(SITE_MODULE_DIR, 'router.js'), 'utf8')
    .replace("import cf from 'cloudfront';", '')
    .replace('__SFORGE_CONFIG__', JSON.stringify(config));
  const cf = {
    kvs: () => ({
      async get(key: string) {
        const value = kvs.get(key);
        if (value === undefined) throw new Error(`Key ${key} not found`);
        return value;
      },
    }),
  };
  return new Function('cf', `${source}\nreturn handler;`)(cf) as Handler;
}

function event(uri: string, host = 'www.example.com', querystring = {}) {
  return { request: { uri, querystring, headers: { host: { value: host } } } };
}

type Outcome = { status: number; file?: string } | { status: 301; location: string };

/**
 * What a viewer gets from CloudFront + S3: the function's redirect, or the
 * object it rewrote the URI to, or the 404 page when that object is missing.
 */
async function viaCloudFront(
  handler: Handler,
  uri: string,
  files: Set<string>,
  version: string,
): Promise<Outcome> {
  const response = await handler(event(uri));
  if (response.statusCode === 301)
    return { status: 301, location: response.headers!.location!.value };
  if (response.statusCode !== undefined) return { status: response.statusCode };
  const prefix = `/v/${version}/`;
  expect(response.uri!.startsWith(prefix)).toBe(true);
  const key = response
    .uri!.slice(prefix.length)
    .split('/')
    .map((s) => decodeURIComponent(s))
    .join('/');
  if (files.has(key)) return { status: 200, file: key };
  return files.has('404.html') ? { status: 404, file: '404.html' } : { status: 404 };
}

function viaLocalServer(uri: string, files: Set<string>, trailingSlash: TrailingSlash): Outcome {
  const r = resolveRequest(uri, (p) => files.has(p), { trailingSlash });
  if (r.kind === 'redirect') return { status: 301, location: r.location };
  if (r.kind === 'file') return { status: r.status, file: r.path };
  return { status: 404 };
}

/** Follow redirects (both sides), comparing where a URL finally lands. */
async function final(
  get: (uri: string) => Promise<Outcome> | Outcome,
  uri: string,
): Promise<Outcome> {
  let outcome = await get(uri);
  for (let hops = 0; outcome.status === 301 && hops < 3; hops++) {
    outcome = await get((outcome as { location: string }).location);
  }
  return outcome;
}

const SITE_ALWAYS = [
  'index.html',
  '404.html',
  'about/index.html',
  'blog/index.html',
  'blog/hello/index.html',
  'blog/page/2/index.html',
  'café/index.html',
  'assets/site.4f2a.css',
  'a b.txt',
  'legacy.html',
  'LICENSE',
  'feed.xml',
];

const SITE_NEVER = [
  'index.html',
  '404.html',
  'about.html',
  'blog/index.html',
  'blog/hello.html',
  'tags/index.html',
  'tags/release.html',
  'café.html',
  'assets/site.4f2a.css',
  'LICENSE',
];

function urlsFor(files: string[]): string[] {
  const urls = new Set([
    '/',
    '/missing',
    '/missing/',
    '/.sforge/build-manifest.json',
    '/a/../about/',
    '/%2e%2e/x',
    '/a//b',
    '/%E0%A4%A',
    '/a%5Cb',
    '/about.html',
    '/caf%C3%A9',
    '/caf%c3%a9/',
  ]);
  for (const file of files) {
    const encoded = `/${file.split('/').map(encodeURIComponent).join('/')}`;
    urls.add(encoded);
    if (file.endsWith('/index.html')) {
      const dir = encoded.slice(0, -'index.html'.length);
      urls.add(dir).add(dir.slice(0, -1));
    } else if (file.endsWith('.html')) {
      const page = encoded.slice(0, -'.html'.length);
      urls.add(page).add(`${page}/`);
    } else {
      urls.add(`${encoded}/`);
    }
  }
  return [...urls];
}

describe.each([
  ['always', SITE_ALWAYS],
  ['never', SITE_NEVER],
] as const)('router.js with trailingSlash: %s', (trailingSlash, list) => {
  const files = new Set(list);
  const version = '20261024T173405Z-6ffcbe4';
  const exceptions = routeExceptions(list, trailingSlash, version);
  const kvs = new Map<string, string>([['active', version]]);
  for (const [key, value] of Object.entries(exceptions.entries))
    kvs.set(`r:${version}:${key}`, value);
  const handler = loadRouter({ trailingSlash, previewSuffix: '.preview.example.com' }, kvs);

  it.each(urlsFor(list))('serves %s like sforge preview', async (uri) => {
    const cloud = await final((u) => viaCloudFront(handler, u, files, version), uri);
    const local = await final((u) => viaLocalServer(u, files, trailingSlash), uri);
    expect(cloud).toEqual(local);
  });

  it('answers redirects in one hop for existing pages', async () => {
    for (const uri of urlsFor(list)) {
      const local = viaLocalServer(uri, files, trailingSlash);
      if (local.status !== 301) continue;
      expect(await viaCloudFront(handler, uri, files, version)).toEqual(local);
    }
  });
});

describe('router.js versions and previews', () => {
  const kvs = new Map([
    ['active', 'v1'],
    ['host:pr-7', 'pr-7'],
  ]);
  const handler = loadRouter(
    { trailingSlash: 'always', previewSuffix: '.preview.example.com' },
    kvs,
  );

  it('prefixes the active version and keeps the query string on redirects', async () => {
    expect((await handler(event('/about/'))).uri).toBe('/v/v1/about/index.html');
    const redirect = await handler(
      event('/about', 'www.example.com', {
        q: { value: 'x y' },
        tag: { value: 'a', multiValue: [{ value: 'a' }, { value: 'b' }] },
      }),
    );
    expect(redirect).toMatchObject({
      statusCode: 301,
      headers: { location: { value: '/about/?q=x y&tag=a&tag=b' } },
    });
  });

  it('serves a preview host from its own version', async () => {
    expect((await handler(event('/', 'pr-7.preview.example.com'))).uri).toBe('/v/pr-7/index.html');
    expect(await handler(event('/', 'pr-8.preview.example.com'))).toMatchObject({
      statusCode: 404,
    });
  });

  it('passes CloudFront error page requests through and answers 503 before the first deploy', async () => {
    expect((await handler(event('/_sforge/errors/404.html'))).uri).toBe('/_sforge/errors/404.html');
    expect((await handler(event('/_sforge/versions.json'))).uri).toBe(
      '/v/v1/_sforge/versions.json',
    );
    expect((await handler(event('/_sforge/errors/../versions.json'))).uri).toBe(
      '/v/v1/_sforge/missing',
    );
    const empty = loadRouter(
      { trailingSlash: 'always', previewSuffix: '' },
      new Map([['active', 'none']]),
    );
    expect(await empty(event('/'))).toMatchObject({ statusCode: 503 });
  });
});

describe('routeExceptions', () => {
  it('needs only /index for a conventional trailingSlash: always site', () => {
    const { entries } = routeExceptions(
      ['index.html', 'about/index.html', 'blog/index.html', 'x.css'],
      'always',
      'v1',
    );
    expect(entries).toEqual({ '/index': 'f:index.html' });
  });

  it('lists section pages for trailingSlash: never', () => {
    const { entries } = routeExceptions(
      ['index.html', 'about.html', 'blog/index.html'],
      'never',
      'v1',
    );
    expect(entries).toEqual({ '/blog': 'r:/blog/', '/blog/': 'f:blog/index.html' });
  });

  it('skips keys longer than the KVS allows', () => {
    const long = `${'a'.repeat(600)}/index.html`;
    const result = routeExceptions([long, 'index.html'], 'never', 'v1');
    expect(result.skipped).toHaveLength(2);
  });
});
