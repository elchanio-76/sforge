import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { CloudFrontKeyValueStoreClient } from '@aws-sdk/client-cloudfront-keyvaluestore';
import { IAMClient, ListOpenIDConnectProvidersCommand } from '@aws-sdk/client-iam';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { ErrorCode, createLogger, validateConfig } from '@staticforge/core';
import { RECORDS_MODULE_DIR, createCloudflareDns } from '@staticforge/cloudflare';
import type { ProfileInput } from '@staticforge/iac';
import { createAwsIacProfile } from '../src/index.js';

const logger = createLogger({ level: 'silent' });
const ZONE_ID = '9cb70fa80e764481efbd93d9cc565753';

const clients = {
  s3: () => new S3Client({ region: 'eu-north-1' }),
  sts: () => new STSClient({ region: 'eu-north-1' }),
  iam: () => new IAMClient({ region: 'us-east-1' }),
  cloudfront: () => new CloudFrontClient({ region: 'us-east-1' }),
  kvs: () => new CloudFrontKeyValueStoreClient({ region: 'us-east-1' }),
};

beforeEach(() => {
  mockClient(STSClient).on(GetCallerIdentityCommand).resolves({ Account: '123456789012' });
  mockClient(S3Client).on(HeadBucketCommand).resolves({});
  mockClient(IAMClient).on(ListOpenIDConnectProvidersCommand).resolves({});
});

function input(target: Record<string, unknown>): ProfileInput {
  const config = validateConfig({
    site: { title: 'Docs', baseUrl: 'https://docs.example.com' },
    iac: { name: 'docs' },
    targets: { staging: { provider: 'aws', region: 'eu-north-1', ...target } },
  });
  return {
    rootDir: '/project',
    config,
    targetName: 'staging',
    target: config.targets.staging!,
    env: { CLOUDFLARE_API_TOKEN: 'token' },
    logger,
    dns: createCloudflareDns(),
  };
}

const cloudflare = {
  domain: 'aws.sforge.example.com',
  previewDomain: 'preview.aws.sforge.example.com',
  dns: { provider: 'cloudflare', zone: 'example.com', zoneId: ZONE_ID },
};

describe('AWS profile with dns', () => {
  it('creates the validation and routing records with Cloudflare', async () => {
    const prepared = await createAwsIacProfile(clients).prepare(input(cloudflare));
    const { spec } = prepared;
    expect(spec.requiredProviders).toHaveProperty('cloudflare.source', 'cloudflare/cloudflare');
    expect(spec.module.inputs).toMatchObject({
      domain: 'aws.sforge.example.com',
      hosted_zone: null,
      validation_record_fqdns: { ref: 'module.dns_validation.fqdns' },
    });
    expect(spec.additionalModules).toEqual([
      {
        name: 'dns_validation',
        dir: RECORDS_MODULE_DIR,
        inputs: {
          zone_id: ZONE_ID,
          comment: 'staticforge docs/staging',
          records: { ref: 'module.site.dns_validation_records' },
        },
      },
      {
        name: 'dns_routing',
        dir: RECORDS_MODULE_DIR,
        inputs: {
          zone_id: ZONE_ID,
          comment: 'staticforge docs/staging',
          records: { ref: 'module.site.dns_routing_records' },
        },
      },
    ]);
    // The records are created in the same apply: nothing to print and wait for.
    expect(prepared.prePhase).toBeUndefined();
  });

  it('prints the validation records without a hosted zone or dns', async () => {
    const prepared = await createAwsIacProfile(clients).prepare(
      input({ domain: 'docs.example.com' }),
    );
    expect(prepared.spec.additionalModules).toBeUndefined();
    expect(prepared.spec.module.inputs).not.toHaveProperty('validation_record_fqdns');
    expect(prepared.prePhase?.targets).toEqual(['module.site.aws_acm_certificate.site']);
  });

  it('refuses hostedZone together with dns', async () => {
    await expect(
      createAwsIacProfile(clients).prepare(input({ ...cloudflare, hostedZone: 'example.com' })),
    ).rejects.toMatchObject({
      code: ErrorCode.ConfigInvalid,
      message: 'targets.staging sets both hostedZone and dns',
    });
  });

  it('needs the preview domain inside the zone', async () => {
    await expect(
      createAwsIacProfile(clients).prepare(
        input({ ...cloudflare, previewDomain: 'preview.example.org' }),
      ),
    ).rejects.toMatchObject({
      code: ErrorCode.ConfigInvalid,
      message: expect.stringContaining('preview.example.org is not in the DNS zone example.com'),
    });
  });
});
