import { request } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type StaticServer, startStaticServer } from '../src/index.js';

let dir: string;
let outside: string;
let server: StaticServer;

/** A raw request, so paths reach the server exactly as written (no client normalization). */
function get(path: string): Promise<{ status: number; location?: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.port, path, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += String(chunk)));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          ...(res.headers.location !== undefined && { location: res.headers.location }),
          body,
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  const base = mkdtempSync(join(tmpdir(), 'sforge-server-test-'));
  dir = join(base, 'site');
  outside = join(base, 'secret.txt');
  mkdirSync(join(dir, 'docs'), { recursive: true });
  mkdirSync(join(dir, '.sforge'));
  writeFileSync(join(dir, 'index.html'), '<h1>home</h1>');
  writeFileSync(join(dir, 'docs', 'index.html'), '<h1>docs</h1>');
  writeFileSync(join(dir, '.sforge', 'build-manifest.json'), '{"internal":true}');
  writeFileSync(join(dir, '.env'), 'TOKEN=1');
  writeFileSync(outside, 'secret');
  symlinkSync(outside, join(dir, 'leak.txt'));
  server = await startStaticServer({
    root: () => dir,
    host: '127.0.0.1',
    port: 0,
    trailingSlash: 'always',
  });
});

afterAll(async () => {
  await server.close();
  rmSync(join(dir, '..'), { recursive: true, force: true });
});

describe('static server', () => {
  it('serves pages and applies the trailing-slash policy', async () => {
    expect(await get('/')).toMatchObject({ status: 200, body: '<h1>home</h1>' });
    expect(await get('/docs/')).toMatchObject({ status: 200, body: '<h1>docs</h1>' });
    expect(await get('/docs')).toMatchObject({ status: 301, location: '/docs/' });
  });

  it('never serves files outside the site, however the path is written', async () => {
    for (const path of [
      '/..%2fsecret.txt',
      '/%2e%2e/secret.txt',
      '/../secret.txt',
      '/docs/../../secret.txt',
      '/docs/%2e%2e%2f..%2fsecret.txt',
      '/..%5csecret.txt',
      '/leak.txt',
      '/%00',
      '/index.html%00.txt',
    ]) {
      const { status, body } = await get(path);
      expect(body, path).not.toContain('secret');
      expect([301, 400, 404], path).toContain(status);
    }
  });

  it('does not serve dot files or the build bookkeeping', async () => {
    for (const path of ['/.env', '/.sforge/build-manifest.json', '/docs/../.env']) {
      const { status, body } = await get(path);
      expect(status, path).toBe(404);
      expect(body, path).not.toContain('TOKEN');
    }
  });

  it('only redirects to paths on its own host', async () => {
    for (const path of [
      '//evil.example',
      '//evil.example/docs',
      '/.//evil.example',
      '/\\evil.example',
      '/docs//',
    ]) {
      const { location } = await get(path);
      if (location !== undefined) expect(location, path).toMatch(/^\/(?![/\\])/);
    }
  });

  it('refuses other methods', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: server.port, path: '/', method: 'POST' },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(405);
  });
});
