import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type StaticServer, startStaticServer } from '@staticforge/server';
import { injectClient, startPreviewServer } from '../src/index.js';
import { tempDir } from './helpers.js';

describe('startStaticServer', () => {
  let server: StaticServer;
  const root = tempDir({
    'index.html': '<!doctype html><html><head><title>Home</title></head><body>Home</body></html>',
    'about/index.html': '<p>About</p>',
    '404.html': '<p>Lost</p>',
    'video.mp4': Buffer.from('0123456789'),
    'data.json': '{}',
    '.sforge/build-manifest.json': '{}',
  });
  symlinkSync('/etc/hostname', join(root, 'escape.txt'));

  beforeAll(async () => {
    server = await startStaticServer({
      root: () => root,
      host: '127.0.0.1',
      port: 0,
      trailingSlash: 'always',
      transformHtml: injectClient,
    });
  });
  afterAll(() => server.close());

  const get = (path: string, init?: RequestInit) =>
    fetch(server.url + path, { redirect: 'manual', ...init });

  it('serves pages with production URL semantics and content types', async () => {
    const home = await get('/');
    expect(home.status).toBe(200);
    expect(home.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(home.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await home.text()).toContain(
      '<script type="module" src="/__sforge/client.js"></script></head>',
    );

    const about = await get('/about');
    expect(about.status).toBe(301);
    expect(about.headers.get('location')).toBe('/about/');

    expect((await get('/about?x=1')).headers.get('location')).toBe('/about/?x=1');
    expect((await get('/data.json')).headers.get('content-type')).toBe(
      'application/json; charset=utf-8',
    );
    expect((await get('/video.mp4')).headers.get('content-type')).toBe('video/mp4');
  });

  it('serves the 404 page with status 404, and never exposes dot-files or escaping symlinks', async () => {
    for (const path of [
      '/nope',
      '/.sforge/build-manifest.json',
      '/escape.txt',
      '/..%2f..%2fetc/passwd',
    ]) {
      const response = await get(path);
      expect(response.status, path).toBe(404);
      expect(await response.text()).toContain('Lost');
    }
  });

  it('supports HEAD and byte ranges for media', async () => {
    const head = await get('/video.mp4', { method: 'HEAD' });
    expect(head.headers.get('content-length')).toBe('10');
    expect(head.headers.get('accept-ranges')).toBe('bytes');
    expect(await head.text()).toBe('');

    const partial = await get('/video.mp4', { headers: { Range: 'bytes=2-4' } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toBe('bytes 2-4/10');
    expect(await partial.text()).toBe('234');

    const suffix = await get('/video.mp4', { headers: { Range: 'bytes=-3' } });
    expect(await suffix.text()).toBe('789');

    expect((await get('/video.mp4', { headers: { Range: 'bytes=20-' } })).status).toBe(416);
  });

  it('rejects other methods', async () => {
    const response = await get('/', { method: 'POST' });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
  });

  it('reports a busy port with a stable error code', async () => {
    await expect(
      startStaticServer({
        root: () => root,
        host: '127.0.0.1',
        port: server.port,
        trailingSlash: 'always',
      }),
    ).rejects.toMatchObject({ code: 'SF_PORT_IN_USE', hint: expect.stringContaining('--port 0') });
  });
});

describe('startPreviewServer', () => {
  it('serves a build without injecting the dev client', async () => {
    const dir = tempDir({ 'index.html': '<html><head></head><body>Built</body></html>' });
    const server = await startPreviewServer({
      dir,
      host: '127.0.0.1',
      port: 0,
      trailingSlash: 'always',
    });
    try {
      const html = await (await fetch(`${server.url}/`)).text();
      expect(html).toBe('<html><head></head><body>Built</body></html>');
    } finally {
      await server.close();
    }
  });

  it('refuses to serve a missing or empty build', async () => {
    await expect(
      startPreviewServer({
        dir: join(tempDir({}), 'dist'),
        host: '127.0.0.1',
        port: 0,
        trailingSlash: 'always',
      }),
    ).rejects.toMatchObject({ code: 'SF_NOT_BUILT' });
  });
});
