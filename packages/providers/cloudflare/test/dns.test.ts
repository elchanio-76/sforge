import { describe, expect, it } from 'vitest';
import { ErrorCode, createLogger } from '@staticforge/core';
import { iacRef } from '@staticforge/iac';
import { type Fetch, RECORDS_MODULE_DIR, createCloudflareDns, lookupZone } from '../src/index.js';

const logger = createLogger({ level: 'silent' });
const ZONE_ID = '9cb70fa80e764481efbd93d9cc565753';

function fakeFetch(status: number, body: unknown): Fetch & { calls: [string, RequestInit][] } {
  const calls: [string, RequestInit][] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push([url, init]);
    return new Response(JSON.stringify(body), { status });
  }) as unknown as Fetch & { calls: [string, RequestInit][] };
  impl.calls = calls;
  return impl;
}

const found = { success: true, result: [{ id: ZONE_ID, name: 'example.com' }] };

function input(overrides: Record<string, unknown> = {}) {
  return {
    dns: { provider: 'cloudflare' as const, zone: 'example.com' },
    owner: 'docs/staging',
    env: { CLOUDFLARE_API_TOKEN: 'secret-token' },
    logger,
    ...overrides,
  };
}

describe('lookupZone', () => {
  it('finds the zone by name with the token', async () => {
    const fetch = fakeFetch(200, found);
    expect(await lookupZone('example.com', 'secret-token', fetch)).toBe(ZONE_ID);
    const [url, init] = fetch.calls[0]!;
    expect(url).toBe('https://api.cloudflare.com/client/v4/zones?name=example.com');
    expect(init.headers).toEqual({ authorization: 'Bearer secret-token' });
  });

  it('reports a refused token as an auth error with a hint', async () => {
    await expect(
      lookupZone('example.com', 't', fakeFetch(403, { success: false })),
    ).rejects.toMatchObject({
      code: ErrorCode.CloudAuth,
      hint: expect.stringContaining('Zone → DNS → Edit'),
    });
  });

  it('reports a zone the token cannot see as a config error', async () => {
    await expect(
      lookupZone('example.com', 't', fakeFetch(200, { success: true, result: [] })),
    ).rejects.toMatchObject({
      code: ErrorCode.ConfigInvalid,
      message: expect.stringContaining('sees no zone named example.com'),
    });
  });

  it('passes on API errors and unreachable APIs', async () => {
    await expect(
      lookupZone(
        'example.com',
        't',
        fakeFetch(400, { success: false, errors: [{ message: 'Invalid request headers' }] }),
      ),
    ).rejects.toMatchObject({
      code: ErrorCode.CloudAuth,
      message: 'Could not look up the Cloudflare zone example.com: Invalid request headers',
    });
    const offline = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as Fetch;
    await expect(lookupZone('example.com', 't', offline)).rejects.toMatchObject({
      code: ErrorCode.CloudAuth,
      message: expect.stringContaining('Could not reach the Cloudflare API'),
    });
  });
});

describe('createCloudflareDns', () => {
  it('looks the zone up and creates records modules with it', async () => {
    const fetch = fakeFetch(200, found);
    const prepared = await createCloudflareDns({ fetch }).prepare(input());
    expect(prepared.requiredProviders).toEqual({
      cloudflare: { source: 'cloudflare/cloudflare', version: '>= 5.0, < 6.0' },
    });
    // The provider reads the token from the environment: nothing is written to the workspace.
    expect(prepared.providers).toEqual({});
    expect(prepared.records('dns_routing', iacRef('module.site.dns_records'))).toEqual({
      name: 'dns_routing',
      dir: RECORDS_MODULE_DIR,
      inputs: {
        zone_id: ZONE_ID,
        comment: 'staticforge docs/staging',
        records: { ref: 'module.site.dns_records' },
      },
    });
    expect(JSON.stringify(prepared)).not.toContain('secret-token');
  });

  it('uses a configured zone ID without a lookup', async () => {
    const fetch = fakeFetch(500, {});
    const prepared = await createCloudflareDns({ fetch }).prepare(
      input({ dns: { provider: 'cloudflare', zone: 'example.com', zoneId: ZONE_ID } }),
    );
    expect(prepared.records('r', iacRef('x')).inputs.zone_id).toBe(ZONE_ID);
    expect(fetch.calls).toHaveLength(0);
  });

  it('needs the API token, except to read outputs', async () => {
    const fetch = fakeFetch(200, found);
    await expect(createCloudflareDns({ fetch }).prepare(input({ env: {} }))).rejects.toMatchObject({
      code: ErrorCode.CloudAuth,
      message: 'CLOUDFLARE_API_TOKEN is not set',
      hint: expect.stringContaining('example.com'),
    });
    const outputs = await createCloudflareDns({ fetch }).prepare(
      input({ env: {}, purpose: 'outputs' }),
    );
    expect(outputs.records('r', iacRef('x')).inputs.zone_id).toBe('');
    expect(fetch.calls).toHaveLength(0);
  });

  it('keeps record comments within the Free plan limit', async () => {
    const prepared = await createCloudflareDns({ fetch: fakeFetch(200, found) }).prepare(
      input({ owner: `${'x'.repeat(120)}/staging` }),
    );
    expect(String(prepared.records('r', iacRef('x')).inputs.comment)).toHaveLength(100);
  });
});
