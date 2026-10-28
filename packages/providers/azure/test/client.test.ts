import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@staticforge/core';
import { PINNED_CLIENT_BUILD, clientPlatform, ensureClient } from '../src/client.js';
import { clientEnv } from '../src/uploader.js';

const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

let cache: string;
beforeEach(() => {
  cache = mkdtempSync(join(tmpdir(), 'sforge-client-test-'));
});
afterEach(() => rmSync(cache, { recursive: true, force: true }));

describe('deployment client download', () => {
  it('maps Node platforms to Microsoft builds', () => {
    expect(clientPlatform('linux')).toBe('linux-x64');
    expect(clientPlatform('darwin')).toBe('osx-x64');
    expect(clientPlatform('win32')).toBe('win-x64');
    expect(clientPlatform('android')).toBeUndefined();
  });

  it('refuses a download that does not match the pinned checksum', async () => {
    const fetch = async () => new Response(Buffer.from('not the client'));
    await expect(
      ensureClient({ logger, env: { SFORGE_CACHE_DIR: cache }, fetch, platform: 'linux' }),
    ).rejects.toMatchObject({ code: 'SF_DEPLOY_FAILED' });
    expect(existsSync(join(cache, 'bin'))).toBe(false);
  });

  it('falls back to the stable build when the pinned one is gone, checking its checksum', async () => {
    const body = Buffer.from('stable client');
    const urls: string[] = [];
    const fetch = async (url: string) => {
      urls.push(url);
      if (url.includes(PINNED_CLIENT_BUILD)) return new Response('gone', { status: 404 });
      if (url.includes('aka.ms')) {
        return Response.json([
          {
            version: 'stable',
            buildId: 'newbuild',
            files: {
              'linux-x64': { url: 'https://cdn.example/linux/StaticSitesClient', sha: sha(body) },
            },
          },
        ]);
      }
      return new Response(body);
    };
    const path = await ensureClient({
      logger,
      env: { SFORGE_CACHE_DIR: cache },
      fetch,
      platform: 'linux',
    });
    expect(path).toBe(join(cache, 'bin', 'staticsitesclient-newbuild', 'StaticSitesClient'));
    expect(readFileSync(path)).toEqual(body);
    // cached: the binary is not downloaded again
    urls.length = 0;
    await ensureClient({ logger, env: { SFORGE_CACHE_DIR: cache }, fetch, platform: 'linux' });
    expect(urls.some((u) => u.includes('cdn.example'))).toBe(false);
  });

  it('refuses a platform without a build', async () => {
    await expect(ensureClient({ logger, platform: 'android' })).rejects.toMatchObject({
      code: 'SF_DEPLOY_FAILED',
    });
  });
});

describe('deployment client environment', () => {
  it('passes what the client needs and nothing else', () => {
    const env = clientEnv({
      PATH: '/bin',
      HOME: '/home/x',
      HTTPS_PROXY: 'http://p',
      AWS_SECRET_ACCESS_KEY: 'secret',
      CLOUDFLARE_API_TOKEN: 'secret',
      GITHUB_TOKEN: 'secret',
    });
    expect(Object.keys(env).sort()).toEqual(['HOME', 'HTTPS_PROXY', 'PATH']);
  });
});
