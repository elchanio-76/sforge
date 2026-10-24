import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import {
  CloudFrontKeyValueStoreClient,
  DescribeKeyValueStoreCommand,
  UpdateKeysCommand,
} from '@aws-sdk/client-cloudfront-keyvaluestore';
import {
  IAMClient,
  ListOpenIDConnectProviderTagsCommand,
  ListOpenIDConnectProvidersCommand,
} from '@aws-sdk/client-iam';
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { sdkStreamMixin } from '@smithy/util-stream';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { type SforgeConfig, createLogger, validateConfig } from '@staticforge/core';
import type { Deployer } from '@staticforge/provider-api';
import {
  type AwsClients,
  createAwsDeployer,
  createAwsIacProfile,
  describeValidation,
} from '../src/index.js';

const logger = createLogger({ level: 'silent' });

const s3 = mockClient(S3Client);
const kvs = mockClient(CloudFrontKeyValueStoreClient);
const cloudfront = mockClient(CloudFrontClient);
const sts = mockClient(STSClient);
const iam = mockClient(IAMClient);

const clients: AwsClients = {
  s3: () => new S3Client({ region: 'eu-central-1' }),
  sts: () => new STSClient({ region: 'eu-central-1' }),
  iam: () => new IAMClient({ region: 'us-east-1' }),
  cloudfront: () => new CloudFrontClient({ region: 'us-east-1' }),
  kvs: () => new CloudFrontKeyValueStoreClient({ region: 'us-east-1' }),
};

/** Called after every GetObject of the fake bucket (to simulate concurrent writers). */
let afterGet: ((key: string) => void) | undefined;

/** An in-memory bucket behind the S3 mock, with ETags for conditional writes. */
function fakeBucket() {
  const objects = new Map<
    string,
    { body: string; etag: string; contentType?: string; cacheControl?: string }
  >();
  let n = 0;
  const etag = () => `"etag-${++n}"`;
  s3.on(GetObjectCommand).callsFake(({ Key }) => {
    const object = objects.get(Key);
    if (object === undefined) {
      throw Object.assign(new Error('The specified key does not exist.'), {
        name: 'NoSuchKey',
        $metadata: { httpStatusCode: 404 },
      });
    }
    afterGet?.(Key);
    return { Body: sdkStreamMixin(Readable.from([Buffer.from(object.body)])), ETag: object.etag };
  });
  s3.on(PutObjectCommand).callsFake(async (input) => {
    const existing = objects.get(input.Key);
    if (
      (input.IfNoneMatch === '*' && existing !== undefined) ||
      (input.IfMatch !== undefined && existing?.etag !== input.IfMatch)
    ) {
      throw Object.assign(
        new Error('At least one of the pre-conditions you specified did not hold'),
        {
          name: 'PreconditionFailed',
          $metadata: { httpStatusCode: 412 },
        },
      );
    }
    let body = input.Body;
    if (body instanceof Readable) {
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      body = Buffer.concat(chunks).toString('utf8');
    }
    const tag = etag();
    objects.set(input.Key, {
      body: String(body),
      etag: tag,
      contentType: input.ContentType,
      cacheControl: input.CacheControl,
    });
    return { ETag: tag };
  });
  s3.on(CopyObjectCommand).callsFake((input) => {
    const [, ...rest] = input.CopySource.split('/');
    const source = objects.get(rest.map(decodeURIComponent).join('/'));
    if (source === undefined) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
    objects.set(input.Key, {
      ...source,
      etag: etag(),
      ...(input.MetadataDirective === 'REPLACE' && {
        contentType: input.ContentType,
        cacheControl: input.CacheControl,
      }),
    });
    return {};
  });
  s3.on(HeadObjectCommand).callsFake(({ Key }) => {
    if (!objects.has(Key))
      throw Object.assign(new Error('NotFound'), {
        name: 'NotFound',
        $metadata: { httpStatusCode: 404 },
      });
    return {};
  });
  s3.on(ListObjectsV2Command).callsFake(({ Prefix }) => ({
    Contents: [...objects.keys()].filter((k) => k.startsWith(Prefix)).map((Key) => ({ Key })),
    IsTruncated: false,
  }));
  s3.on(DeleteObjectsCommand).callsFake(({ Delete }) => {
    for (const { Key } of Delete.Objects) objects.delete(Key);
    return {};
  });
  return objects;
}

/** An in-memory KeyValueStore behind the KVS mock. */
function fakeKvs() {
  const store = new Map<string, string>([['active', 'none']]);
  let version = 0;
  kvs.on(DescribeKeyValueStoreCommand).callsFake(() => ({ ETag: `kvs-${version}` }));
  kvs.on(UpdateKeysCommand).callsFake(({ IfMatch, Puts = [], Deletes = [] }) => {
    if (IfMatch !== `kvs-${version}`) throw new Error('ETag mismatch');
    if (Puts.length + Deletes.length > 50) throw new Error('Too many keys');
    for (const { Key, Value } of Puts) store.set(Key, Value);
    for (const { Key } of Deletes) store.delete(Key);
    version++;
    return { ETag: `kvs-${version}` };
  });
  return store;
}

function writeBuild(files: Record<string, string>, immutable: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'sforge-aws-build-'));
  const manifest: Record<string, unknown> = {};
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
    manifest[path] = {
      sha256: createHash('sha256').update(body).digest('hex'),
      size: Buffer.byteLength(body),
      cache: immutable.includes(path) ? 'immutable' : 'revalidate',
    };
  }
  mkdirSync(join(dir, '.sforge'), { recursive: true });
  writeFileSync(
    join(dir, '.sforge', 'build-manifest.json'),
    JSON.stringify({ version: 1, files: manifest }),
  );
  return dir;
}

function config(target: Record<string, unknown> = {}): SforgeConfig {
  return validateConfig({
    site: { title: 'Docs', baseUrl: 'https://docs.example.com' },
    build: { trailingSlash: 'never' },
    targets: {
      staging: { provider: 'aws', region: 'eu-central-1', retainVersions: 2, ...target },
    },
  });
}

const outputs = {
  bucket: 'sforge-docs-staging-abc',
  bucket_region: 'eu-central-1',
  kvs_arn: 'arn:aws:cloudfront::123456789012:key-value-store/abc',
  distribution_id: 'E2EXAMPLE',
  url: 'https://d111.cloudfront.net',
  preview_domain: 'preview.example.com',
  trailing_slash: 'never',
};

function deployer(cfg = config(), out: Record<string, unknown> = outputs): Deployer {
  return createAwsDeployer(
    {
      rootDir: mkdtempSync(join(tmpdir(), 'sforge-aws-root-')),
      config: cfg,
      targetName: 'staging',
      target: cfg.targets.staging!,
      outputs: out,
      env: {},
      logger,
    },
    clients,
  );
}

beforeEach(() => {
  afterGet = undefined;
  s3.reset();
  kvs.reset();
  cloudfront.reset();
  sts.reset();
  iam.reset();
});

const site = {
  'index.html': '<h1>Home</h1>',
  '404.html': '<h1>Not found</h1>',
  'about.html': '<h1>About</h1>',
  'blog/index.html': '<h1>Blog</h1>',
  'assets/site.4f2a.css': 'body{}',
};

describe('AWS deployer', () => {
  it('uploads a version, publishes the 404 page and switches the active key', async () => {
    const objects = fakeBucket();
    const store = fakeKvs();
    const result = await deployer().deploy({
      buildDir: writeBuild(site, ['assets/site.4f2a.css']),
      gitSha: 'abc1234',
      now: new Date('2026-10-24T17:34:05Z'),
    });
    const id = '20261024T173405Z-abc1234';
    expect(result).toMatchObject({
      versionId: id,
      uploaded: 5,
      copied: 0,
      url: 'https://d111.cloudfront.net',
      preview: false,
    });

    expect(objects.get(`v/${id}/index.html`)).toMatchObject({
      contentType: 'text/html; charset=utf-8',
      cacheControl: 'public, max-age=0, must-revalidate',
    });
    expect(objects.get(`v/${id}/assets/site.4f2a.css`)).toMatchObject({
      contentType: 'text/css; charset=utf-8',
      cacheControl: 'public, max-age=31536000, immutable',
    });
    expect([...objects.keys()].some((k) => k.includes('.sforge'))).toBe(false);
    expect(objects.get('_sforge/errors/404.html')?.body).toBe('<h1>Not found</h1>');
    expect(store.get('active')).toBe(id);
    // trailingSlash "never": the blog section is an exception to the router's rules.
    expect(store.get(`r:${id}:/blog`)).toBe('r:/blog/');
    expect(store.get(`r:${id}:/blog/`)).toBe('f:blog/index.html');

    const put = s3
      .commandCalls(PutObjectCommand)
      .find((c) => c.args[0].input.Key === `v/${id}/index.html`)!;
    expect(put.args[0].input.ChecksumSHA256).toBe(
      createHash('sha256').update('<h1>Home</h1>').digest('base64'),
    );
    const versions = JSON.parse(objects.get('_sforge/versions.json')!.body);
    expect(versions).toMatchObject({ active: id, versions: [{ id, files: 5, gitSha: 'abc1234' }] });
  });

  it('copies unchanged files server-side, prunes old versions and rolls back', async () => {
    const objects = fakeBucket();
    const store = fakeKvs();
    const d = deployer();
    const times = ['2026-10-24T10:00:00Z', '2026-10-24T11:00:00Z', '2026-10-24T12:00:00Z'];
    const results = [];
    for (const [i, time] of times.entries()) {
      results.push(
        await d.deploy({
          buildDir: writeBuild({ ...site, 'index.html': `<h1>Home ${i}</h1>` }),
          gitSha: 'abc1234',
          now: new Date(time),
        }),
      );
    }
    expect(results[1]).toMatchObject({
      uploaded: 1,
      copied: 4,
      previousVersionId: results[0]!.versionId,
    });
    expect(
      s3
        .commandCalls(CopyObjectCommand)
        .some((c) => c.args[0].input.CopySource.includes(`/v/${results[0]!.versionId}/about.html`)),
    ).toBe(true);

    // retainVersions: 2 removes the first version entirely.
    expect(results[2]!.pruned).toEqual([results[0]!.versionId]);
    expect([...objects.keys()].some((k) => k.startsWith(`v/${results[0]!.versionId}/`))).toBe(
      false,
    );
    expect(store.has(`r:${results[0]!.versionId}:/blog`)).toBe(false);

    const versions = await d.versions();
    expect(versions.map((v) => [v.id, v.active])).toEqual([
      [results[2]!.versionId, true],
      [results[1]!.versionId, false],
    ]);

    const rollback = await d.rollback();
    expect(rollback).toEqual({
      target: 'staging',
      versionId: results[1]!.versionId,
      previousVersionId: results[2]!.versionId,
      url: 'https://d111.cloudfront.net',
    });
    expect(store.get('active')).toBe(results[1]!.versionId);
    await expect(d.rollback('20200101T000000Z-x')).rejects.toMatchObject({
      code: 'SF_VERSION_NOT_FOUND',
    });
    await expect(d.rollback(results[2]!.versionId)).resolves.toMatchObject({
      versionId: results[2]!.versionId,
    });
  });

  it('deploys PR previews in place and removes them', async () => {
    const objects = fakeBucket();
    const store = fakeKvs();
    const d = deployer();
    const first = await d.deploy({ buildDir: writeBuild(site), preview: 'pr-42' });
    expect(first).toMatchObject({
      versionId: 'pr-42',
      url: 'https://pr-42.preview.example.com',
      uploaded: 5,
      preview: true,
    });
    expect(store.get('host:pr-42')).toBe('pr-42');
    expect(store.get('active')).toBe('none');

    const rest: Record<string, string> = { ...site };
    delete rest['about.html'];
    const second = await d.deploy({
      buildDir: writeBuild({ ...rest, 'index.html': 'changed' }),
      preview: 'pr-42',
    });
    expect(second).toMatchObject({ uploaded: 1, skipped: 3, deleted: 1 });
    expect(objects.has('v/pr-42/about.html')).toBe(false);

    expect((await d.versions()).find((v) => v.id === 'pr-42')).toMatchObject({
      preview: true,
      active: false,
    });
    const removed = await d.destroyPreview('pr-42');
    expect(removed).toMatchObject({ existed: true, deleted: 4 });
    expect(store.has('host:pr-42')).toBe(false);
    expect([...store.keys()].some((k) => k.startsWith('r:pr-42:'))).toBe(false);
  });

  it('refuses previews without a preview domain and invalid ids', async () => {
    fakeBucket();
    fakeKvs();
    const d = deployer(config(), { ...outputs, preview_domain: null });
    await expect(d.deploy({ buildDir: writeBuild(site), preview: 'pr-1' })).rejects.toMatchObject({
      code: 'SF_UNSUPPORTED',
    });
    await expect(
      deployer().deploy({ buildDir: writeBuild(site), preview: 'PR 1' }),
    ).rejects.toMatchObject({
      code: 'SF_USAGE',
    });
  });

  it('changes nothing in a dry run, and invalidates on request', async () => {
    const objects = fakeBucket();
    const store = fakeKvs();
    const dry = await deployer().deploy({ buildDir: writeBuild(site), dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, uploaded: 5 });
    expect(objects.size).toBe(0);
    expect(store.get('active')).toBe('none');

    cloudfront.on(CreateInvalidationCommand).resolves({});
    const real = await deployer().deploy({ buildDir: writeBuild(site), invalidate: true });
    expect(real.invalidated).toBe(true);
    expect(cloudfront.commandCalls(CreateInvalidationCommand)[0]!.args[0].input).toMatchObject({
      DistributionId: 'E2EXAMPLE',
      InvalidationBatch: { Paths: { Items: ['/*'] } },
    });
  });

  it('detects a concurrent deploy through the versions document ETag', async () => {
    const objects = fakeBucket();
    fakeKvs();
    const d = deployer();
    await d.deploy({ buildDir: writeBuild(site), now: new Date('2026-10-24T10:00:00Z') });
    // Someone else rewrites versions.json between our read and write.
    afterGet = (key) => {
      if (key !== '_sforge/versions.json') return;
      afterGet = undefined;
      objects.set(key, { ...objects.get(key)!, etag: '"other"' });
    };
    await expect(
      d.deploy({ buildDir: writeBuild(site), now: new Date('2026-10-24T11:00:00Z') }),
    ).rejects.toMatchObject({
      code: 'SF_DEPLOY_FAILED',
      message: expect.stringContaining('at the same time'),
    });
  });

  it('requires provisioned outputs', async () => {
    await expect(deployer(config(), {}).current()).rejects.toMatchObject({
      code: 'SF_NOT_PROVISIONED',
    });
  });
});

describe('AWS IaC profile', () => {
  const input = (cfg: SforgeConfig, purpose?: 'outputs') => ({
    rootDir: '/project',
    config: cfg,
    targetName: 'staging',
    target: cfg.targets.staging!,
    env: {},
    logger,
    ...(purpose && { purpose }),
  });

  it('derives the state backend, module inputs and providers', async () => {
    sts.on(GetCallerIdentityCommand).resolves({ Account: '123456789012' });
    s3.on(HeadBucketCommand).rejects(
      Object.assign(new Error('NotFound'), {
        name: 'NotFound',
        $metadata: { httpStatusCode: 404 },
      }),
    );
    const prepared = await createAwsIacProfile(clients).prepare(input(config()));

    expect(prepared.state).toMatchObject({
      id: 'aws-123456789012-eu-central-1',
      description: 's3://sforge-state-123456789012-eu-central-1/docs-example-com/staging.tfstate',
      exists: false,
    });
    expect(prepared.spec.backend).toEqual({
      type: 's3',
      config: {
        bucket: 'sforge-state-123456789012-eu-central-1',
        key: 'docs-example-com/staging.tfstate',
        region: 'eu-central-1',
        encrypt: true,
        use_lockfile: true,
      },
    });
    expect(prepared.state.bootstrap.backend.config).toMatchObject({
      key: '_sforge/state-bootstrap.tfstate',
    });
    expect(prepared.state.bootstrap.module.inputs).toEqual({
      bucket_name: 'sforge-state-123456789012-eu-central-1',
      kms_key_arn: null,
    });
    expect(prepared.spec.providers.aws).toEqual([
      expect.objectContaining({ region: 'eu-central-1' }),
      expect.objectContaining({ alias: 'us_east_1', region: 'us-east-1' }),
    ]);
    expect(prepared.spec.module.inputs).toMatchObject({
      name: 'docs-example-com',
      target: 'staging',
      trailing_slash: 'never',
      domain: null,
      ci: null,
      search_paths: ['/search', '/search.html', '/pagefind/*'],
      security_headers: {
        hsts_max_age: 63072000,
        frame_options: 'SAMEORIGIN',
        search_content_security_policy: expect.stringContaining(
          "script-src 'self' 'wasm-unsafe-eval'",
        ),
      },
    });
    expect(prepared.preDestroyInputs).toEqual({ force_destroy: true });
    expect(prepared.prePhase).toBeUndefined();
  });

  it('reuses a foreign GitHub OIDC provider and keeps its own', async () => {
    sts.on(GetCallerIdentityCommand).resolves({ Account: '123456789012' });
    s3.on(HeadBucketCommand).resolves({});
    const arn = 'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com';
    iam
      .on(ListOpenIDConnectProvidersCommand)
      .resolves({ OpenIDConnectProviderList: [{ Arn: arn }] });
    iam.on(ListOpenIDConnectProviderTagsCommand).resolves({ Tags: [] });
    const cfg = config({ ci: { repo: 'acme/docs' } });
    const foreign = await createAwsIacProfile(clients).prepare(input(cfg));
    expect(foreign.spec.module.inputs.ci).toMatchObject({
      repo: 'acme/docs',
      branches: ['main'],
      create_oidc_provider: false,
      oidc_provider_arn: arn,
      state_key: 'docs-example-com/staging.tfstate',
    });

    iam
      .on(ListOpenIDConnectProviderTagsCommand)
      .resolves({ Tags: [{ Key: 'sforge:owner', Value: 'docs-example-com-staging' }] });
    const own = await createAwsIacProfile(clients).prepare(input(cfg));
    expect(own.spec.module.inputs.ci).toMatchObject({
      create_oidc_provider: true,
      oidc_provider_arn: null,
    });

    // Reading outputs (deploys in CI) needs no IAM or bucket lookups.
    iam.reset();
    s3.reset();
    const outputsOnly = await createAwsIacProfile(clients).prepare(input(cfg, 'outputs'));
    expect(outputsOnly.state.exists).toBe(true);
    expect(iam.calls()).toHaveLength(0);
    expect(s3.calls()).toHaveLength(0);
  });

  it('creates the certificate first when DNS is not in Route 53', async () => {
    sts.on(GetCallerIdentityCommand).resolves({ Account: '123456789012' });
    s3.on(HeadBucketCommand).resolves({});
    const prepared = await createAwsIacProfile(clients).prepare(
      input(config({ domain: 'docs.example.com', previewDomain: 'preview.example.com' })),
    );
    expect(prepared.prePhase?.targets).toEqual(['module.site.aws_acm_certificate.site']);
    expect(
      describeValidation({
        validation_records: [
          { name: '_x.docs.example.com.', type: 'CNAME', value: '_y.acm-validations.aws.' },
        ],
      }),
    ).toContain('_x.docs.example.com. CNAME _y.acm-validations.aws.');
  });

  it('maps credential and access errors to SF_CLOUD_AUTH', async () => {
    sts.on(GetCallerIdentityCommand).rejects(
      Object.assign(new Error('Could not load credentials from any providers'), {
        name: 'CredentialsProviderError',
      }),
    );
    await expect(createAwsIacProfile(clients).prepare(input(config()))).rejects.toMatchObject({
      code: 'SF_CLOUD_AUTH',
    });

    sts.on(GetCallerIdentityCommand).resolves({ Account: '123456789012' });
    s3.on(HeadBucketCommand).rejects(
      Object.assign(new Error('Forbidden'), {
        name: 'Forbidden',
        $metadata: { httpStatusCode: 403 },
      }),
    );
    await expect(createAwsIacProfile(clients).prepare(input(config()))).rejects.toMatchObject({
      code: 'SF_CLOUD_AUTH',
      hint: expect.stringContaining('state.bucket'),
    });
  });

  it('rejects a preview domain without a custom domain', async () => {
    sts.on(GetCallerIdentityCommand).resolves({ Account: '123456789012' });
    s3.on(HeadBucketCommand).resolves({});
    await expect(
      createAwsIacProfile(clients).prepare(input(config({ previewDomain: 'preview.example.com' }))),
    ).rejects.toMatchObject({ code: 'SF_CONFIG_INVALID' });
  });
});
