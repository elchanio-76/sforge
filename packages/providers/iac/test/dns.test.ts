import { describe, expect, it } from 'vitest';
import { ErrorCode, type TargetConfig, createLogger, validateConfig } from '@staticforge/core';
import {
  type DnsProfile,
  type DnsProfileInput,
  type IacSpec,
  type ProfileInput,
  iacRef,
  prepareDns,
  withDns,
} from '../src/index.js';

const logger = createLogger({ level: 'silent' });

function recordingDns(): DnsProfile & { inputs: DnsProfileInput[] } {
  const inputs: DnsProfileInput[] = [];
  return {
    provider: 'cloudflare',
    inputs,
    async prepare(input) {
      inputs.push(input);
      return {
        requiredProviders: { cloudflare: { source: 'cloudflare/cloudflare', version: '>= 5.0' } },
        providers: {},
        records: (name, records) => ({ name, dir: '/records', inputs: { zone_id: 'z', records } }),
      };
    },
  };
}

function input(target: Record<string, unknown>, dns?: DnsProfile): ProfileInput {
  const config = validateConfig({
    site: { title: 'Docs', baseUrl: 'https://docs.example.com' },
    iac: { name: 'docs' },
    targets: { staging: { provider: 'aws', region: 'eu-central-1', ...target } },
  });
  return {
    rootDir: '/project',
    config,
    targetName: 'staging',
    target: config.targets.staging as TargetConfig,
    env: { CLOUDFLARE_API_TOKEN: 't' },
    logger,
    purpose: 'outputs',
    ...(dns && { dns }),
  };
}

const zone = { dns: { provider: 'cloudflare', zone: 'example.com' } };

describe('prepareDns', () => {
  it('is undefined without dns', async () => {
    expect(await prepareDns(input({}), [])).toBeUndefined();
  });

  it('prepares the provider with the owner and purpose', async () => {
    const dns = recordingDns();
    const prepared = await prepareDns(input({ ...zone, domain: 'docs.example.com' }, dns), [
      'docs.example.com',
      '*.preview.example.com',
    ]);
    expect(prepared?.requiredProviders).toHaveProperty('cloudflare');
    expect(dns.inputs[0]).toMatchObject({
      dns: { provider: 'cloudflare', zone: 'example.com' },
      owner: 'docs/staging',
      purpose: 'outputs',
    });
  });

  it('needs a domain inside the zone', async () => {
    const dns = recordingDns();
    await expect(prepareDns(input(zone, dns), [])).rejects.toMatchObject({
      code: ErrorCode.ConfigInvalid,
      message: expect.stringContaining('needs a domain'),
    });
    await expect(
      prepareDns(input({ ...zone, domain: 'docs.example.org' }, dns), ['docs.example.org']),
    ).rejects.toMatchObject({
      code: ErrorCode.ConfigInvalid,
      message: 'docs.example.org is not in the DNS zone example.com (targets.staging.dns.zone)',
    });
    // A suffix that is not a label boundary is outside the zone.
    await expect(
      prepareDns(input({ ...zone, domain: 'docs.badexample.com' }, dns), ['docs.badexample.com']),
    ).rejects.toMatchObject({ code: ErrorCode.ConfigInvalid });
    expect(dns.inputs).toHaveLength(0);
  });

  it('fails when the DNS provider was not loaded', async () => {
    await expect(
      prepareDns(input({ ...zone, domain: 'docs.example.com' }), ['docs.example.com']),
    ).rejects.toMatchObject({ code: ErrorCode.Internal });
  });
});

describe('withDns', () => {
  it('adds the providers and one records module per set', async () => {
    const prepared = await recordingDns().prepare({} as DnsProfileInput);
    const spec: IacSpec = {
      requiredProviders: { aws: { source: 'hashicorp/aws', version: '~> 6.0' } },
      providers: { aws: [{ region: 'eu-central-1' }] },
      module: { name: 'site', dir: '/site', inputs: {} },
      outputs: [],
      backend: { type: 'local', config: {} },
    };
    const result = withDns(spec, prepared, [
      { name: 'dns_routing', records: iacRef('module.site.dns_records') },
    ]);
    expect(Object.keys(result.requiredProviders)).toEqual(['aws', 'cloudflare']);
    expect(result.providers).toEqual(spec.providers);
    expect(result.additionalModules).toEqual([
      {
        name: 'dns_routing',
        dir: '/records',
        inputs: { zone_id: 'z', records: { ref: 'module.site.dns_records' } },
      },
    ]);
    expect(spec.additionalModules).toBeUndefined();
  });
});
