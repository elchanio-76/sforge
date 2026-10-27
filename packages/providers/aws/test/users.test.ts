import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import {
  CloudFrontKeyValueStoreClient,
  DescribeKeyValueStoreCommand,
  GetKeyCommand,
  UpdateKeysCommand,
} from '@aws-sdk/client-cloudfront-keyvaluestore';
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { IAMClient, ListOpenIDConnectProvidersCommand } from '@aws-sdk/client-iam';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { ErrorCode, createLogger, validateConfig } from '@staticforge/core';
import { RECORDS_MODULE_DIR, createCloudflareDns } from '@staticforge/cloudflare';
import type { ProfileInput } from '@staticforge/iac';
import type { DeployerContext } from '@staticforge/provider-api';
import {
  type AwsClients,
  createAwsIacProfile,
  createAwsUserAdmin,
  seedSessionKey,
} from '../src/index.js';

const logger = createLogger({ level: 'silent' });

const kvs = mockClient(CloudFrontKeyValueStoreClient);
const ssm = mockClient(SSMClient);
const cognito = mockClient(CognitoIdentityProviderClient);

const clients: AwsClients = {
  s3: () => new S3Client({ region: 'eu-north-1' }),
  sts: () => new STSClient({ region: 'eu-north-1' }),
  iam: () => new IAMClient({ region: 'us-east-1' }),
  cloudfront: () => new CloudFrontClient({ region: 'us-east-1' }),
  kvs: () => new CloudFrontKeyValueStoreClient({ region: 'us-east-1' }),
  ssm: () => new SSMClient({ region: 'eu-north-1' }),
  cognito: () => new CognitoIdentityProviderClient({ region: 'eu-north-1' }),
};

const KVS_ARN = 'arn:aws:cloudfront::123456789012:key-value-store/abc';
const location = {
  kvsArn: KVS_ARN,
  parameter: '/sforge/docs-staging/auth/key',
  region: 'eu-north-1',
};

beforeEach(() => {
  kvs.reset();
  ssm.reset();
  cognito.reset();
  kvs.on(DescribeKeyValueStoreCommand).resolves({ ETag: 'e1' });
  kvs.on(UpdateKeysCommand).resolves({ ETag: 'e2' });
  ssm.on(PutParameterCommand).resolves({});
  mockClient(STSClient).on(GetCallerIdentityCommand).resolves({ Account: '123456789012' });
  mockClient(S3Client).on(HeadBucketCommand).resolves({});
  mockClient(IAMClient).on(ListOpenIDConnectProvidersCommand).resolves({});
});

function config(target: Record<string, unknown>) {
  return validateConfig({
    site: { title: 'Docs', baseUrl: 'https://docs.example.com' },
    iac: { name: 'docs' },
    targets: { staging: { provider: 'aws', region: 'eu-north-1', ...target } },
  });
}

function context(
  target: Record<string, unknown>,
  outputs: Record<string, unknown>,
): DeployerContext {
  const loaded = config(target);
  return {
    rootDir: '/project',
    config: loaded,
    targetName: 'staging',
    target: loaded.targets.staging!,
    outputs,
    env: {},
    logger,
  };
}

const privateOutputs = {
  kvs_arn: KVS_ARN,
  auth_user_pool_id: 'eu-north-1_Pool',
  auth_key_parameter: '/sforge/docs-staging/auth/key',
};

describe('session key', () => {
  it('is created once, in SSM first and then in the KVS', async () => {
    kvs.on(GetKeyCommand).resolves({ Value: 'none' });
    expect(await seedSessionKey(clients, location)).toBe(true);
    const put = ssm.commandCalls(PutParameterCommand)[0]!.args[0].input;
    expect(put).toMatchObject({ Name: location.parameter, Type: 'SecureString', Overwrite: true });
    expect(put.Value).toMatch(/^[0-9a-f]{64}$/);
    const update = kvs.commandCalls(UpdateKeysCommand)[0]!.args[0].input;
    expect(update).toMatchObject({ KvsARN: KVS_ARN, IfMatch: 'e1' });
    expect(update.Puts).toEqual([{ Key: 'auth:key', Value: put.Value }]);

    kvs.on(GetKeyCommand).resolves({ Value: 'f'.repeat(64) });
    ssm.resetHistory();
    expect(await seedSessionKey(clients, location)).toBe(false);
    expect(ssm.commandCalls(PutParameterCommand)).toHaveLength(0);
  });
});

describe('AWS users', () => {
  it('invites by email; Cognito sends the temporary password', async () => {
    cognito.on(AdminCreateUserCommand).resolves({});
    const users = createAwsUserAdmin(context({ auth: {} }, privateOutputs), clients);
    expect(await users.invite({ user: ' Ana@Example.com ' })).toEqual({
      user: 'ana@example.com',
      emailed: true,
    });
    expect(cognito.commandCalls(AdminCreateUserCommand)[0]!.args[0].input).toEqual({
      UserPoolId: 'eu-north-1_Pool',
      Username: 'ana@example.com',
      UserAttributes: [
        { Name: 'email', Value: 'ana@example.com' },
        { Name: 'email_verified', Value: 'true' },
      ],
      DesiredDeliveryMediums: ['EMAIL'],
    });
  });

  it('reports existing users and refuses names that are not addresses', async () => {
    cognito
      .on(AdminCreateUserCommand)
      .rejects(Object.assign(new Error('exists'), { name: 'UsernameExistsException' }));
    const users = createAwsUserAdmin(context({ auth: {} }, privateOutputs), clients);
    await expect(users.invite({ user: 'ana@example.com' })).rejects.toMatchObject({
      code: ErrorCode.UserExists,
    });
    await expect(users.invite({ user: 'octocat' })).rejects.toMatchObject({
      code: ErrorCode.Usage,
    });
  });

  it('lists every page of users', async () => {
    const created = new Date('2026-10-27T10:00:00Z');
    cognito
      .on(ListUsersCommand)
      .resolvesOnce({
        Users: [
          {
            Username: 'u1',
            UserStatus: 'CONFIRMED',
            Enabled: true,
            UserCreateDate: created,
            Attributes: [
              { Name: 'sub', Value: 'sub-1' },
              { Name: 'email', Value: 'ana@example.com' },
            ],
          },
        ],
        PaginationToken: 'next',
      })
      .resolvesOnce({ Users: [{ Username: 'u2', UserStatus: 'FORCE_CHANGE_PASSWORD' }] });
    const users = createAwsUserAdmin(context({ auth: {} }, privateOutputs), clients);
    expect(await users.list()).toEqual([
      {
        id: 'sub-1',
        name: 'ana@example.com',
        status: 'CONFIRMED',
        enabled: true,
        createdAt: '2026-10-27T10:00:00.000Z',
      },
      { id: 'u2', name: 'u2', status: 'FORCE_CHANGE_PASSWORD' },
    ]);
    expect(cognito.commandCalls(ListUsersCommand)[1]!.args[0].input.PaginationToken).toBe('next');
  });

  it('signs a removed user out of Cognito and deletes them', async () => {
    cognito.on(ListUsersCommand).resolves({ Users: [{ Username: 'u1' }] });
    cognito.on(AdminUserGlobalSignOutCommand).resolves({});
    cognito.on(AdminDeleteUserCommand).resolves({});
    const users = createAwsUserAdmin(context({ auth: {} }, privateOutputs), clients);
    expect(await users.remove('ana@example.com')).toBe(true);
    expect(cognito.commandCalls(ListUsersCommand)[0]!.args[0].input.Filter).toBe(
      'email = "ana@example.com"',
    );
    expect(cognito.commandCalls(AdminDeleteUserCommand)[0]!.args[0].input).toEqual({
      UserPoolId: 'eu-north-1_Pool',
      Username: 'u1',
    });
    cognito.on(ListUsersCommand).resolves({ Users: [] });
    expect(await users.remove('bob@example.com')).toBe(false);
  });

  it('revokes every session by replacing the key', async () => {
    const users = createAwsUserAdmin(context({ auth: {} }, privateOutputs), clients);
    await users.revokeSessions!();
    expect(ssm.commandCalls(PutParameterCommand)).toHaveLength(1);
    expect(kvs.commandCalls(UpdateKeysCommand)).toHaveLength(1);
  });

  it('refuses public and unprovisioned targets', async () => {
    await expect(
      createAwsUserAdmin(context({}, privateOutputs), clients).list(),
    ).rejects.toMatchObject({ code: ErrorCode.Unsupported });
    await expect(
      createAwsUserAdmin(context({ auth: {} }, {}), clients).list(),
    ).rejects.toMatchObject({
      code: ErrorCode.NotProvisioned,
    });
  });
});

describe('AWS profile for private targets', () => {
  function input(target: Record<string, unknown>): ProfileInput {
    const loaded = config(target);
    return {
      rootDir: '/project',
      config: loaded,
      targetName: 'staging',
      target: loaded.targets.staging!,
      env: { CLOUDFLARE_API_TOKEN: 'token' },
      logger,
      dns: createCloudflareDns(),
    };
  }

  it('passes the auth settings and seeds the session key after the apply', async () => {
    const prepared = await createAwsIacProfile(clients).prepare(
      input({ auth: { sessionHours: 2, mfa: 'required' } }),
    );
    expect(prepared.spec.module.inputs).toMatchObject({
      auth: { session_hours: 2, mfa: 'required', allow_cloudfront_host: false },
      private_dns: false,
      site_title: 'Docs',
    });
    expect(prepared.spec.requiredProviders).toHaveProperty('archive');
    expect(prepared.spec.outputs).toEqual(
      expect.arrayContaining(['sign_in_url', 'auth_user_pool_id', 'dns_private_records']),
    );
    expect(prepared.expectedDrift).toContain('module.site.aws_cloudfrontkeyvaluestore_key.auth[0]');

    kvs.on(GetKeyCommand).resolves({ Value: 'none' });
    const notices = await prepared.postApply!(
      { ...privateOutputs, sign_in_url: 'https://d1.cloudfront.net/_sforge/auth/login' },
      logger,
    );
    expect(notices).toEqual([
      'Users sign in at https://d1.cloudfront.net/_sforge/auth/login; invite them with `sforge users invite staging <email>`.',
    ]);
    expect(kvs.commandCalls(UpdateKeysCommand)).toHaveLength(1);
    // Public targets have no key to seed.
    expect(await prepared.postApply!({ kvs_arn: KVS_ARN }, logger)).toEqual([]);
  });

  it('creates only the validation records in the public zone with privateDns', async () => {
    const prepared = await createAwsIacProfile(clients).prepare(
      input({
        domain: 'intra.example.com',
        privateDns: true,
        auth: {},
        dns: {
          provider: 'cloudflare',
          zone: 'example.com',
          zoneId: '9cb70fa80e764481efbd93d9cc565753',
        },
      }),
    );
    expect(prepared.spec.module.inputs).toMatchObject({ private_dns: true });
    expect(prepared.spec.additionalModules?.map((m) => [m.name, m.dir])).toEqual([
      ['dns_validation', RECORDS_MODULE_DIR],
    ]);
  });
});
