// KeyValueStore requests are signed with SigV4a; this registers the pure-JS
// signer, so the native CRT is not needed.
import '@aws-sdk/signature-v4a';
import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { CloudFrontKeyValueStoreClient } from '@aws-sdk/client-cloudfront-keyvaluestore';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { IAMClient } from '@aws-sdk/client-iam';
import { S3Client } from '@aws-sdk/client-s3';
import { SSMClient } from '@aws-sdk/client-ssm';
import { STSClient } from '@aws-sdk/client-sts';
import { ErrorCode, SforgeError } from '@staticforge/core';

/** SDK clients, injectable for tests. Credentials come from the default chain. */
export interface AwsClients {
  s3(region: string): S3Client;
  sts(region: string): STSClient;
  iam(): IAMClient;
  cloudfront(): CloudFrontClient;
  kvs(): CloudFrontKeyValueStoreClient;
  ssm(region: string): SSMClient;
  cognito(region: string): CognitoIdentityProviderClient;
}

export function defaultClients(): AwsClients {
  const cache = new Map<string, unknown>();
  const once = <T>(key: string, create: () => T): T => {
    if (!cache.has(key)) cache.set(key, create());
    return cache.get(key) as T;
  };
  return {
    s3: (region) => once(`s3:${region}`, () => new S3Client({ region })),
    sts: (region) => once(`sts:${region}`, () => new STSClient({ region })),
    iam: () => once('iam', () => new IAMClient({ region: 'us-east-1' })),
    cloudfront: () => once('cloudfront', () => new CloudFrontClient({ region: 'us-east-1' })),
    kvs: () => once('kvs', () => new CloudFrontKeyValueStoreClient({ region: 'us-east-1' })),
    ssm: (region) => once(`ssm:${region}`, () => new SSMClient({ region })),
    cognito: (region) =>
      once(`cognito:${region}`, () => new CognitoIdentityProviderClient({ region })),
  };
}

const AUTH_ERRORS = new Set([
  'CredentialsProviderError',
  'ExpiredToken',
  'ExpiredTokenException',
  'InvalidClientTokenId',
  'UnrecognizedClientException',
  'TokenRefreshRequired',
  'SignatureDoesNotMatch',
]);

/** Error name of an SDK error ("NoSuchKey", "AccessDenied", …). */
export function errorName(error: unknown): string {
  if (error === null || typeof error !== 'object') return '';
  const e = error as { name?: string; Code?: string };
  return e.Code ?? e.name ?? '';
}

export function httpStatus(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
}

/** Wrap an SDK error: credential problems → SF_CLOUD_AUTH, the rest → `code`. */
export function awsError(
  error: unknown,
  what: string,
  code: SforgeError['code'] = ErrorCode.DeployFailed,
): SforgeError {
  if (error instanceof SforgeError) return error;
  const name = errorName(error);
  const message = error instanceof Error ? error.message : String(error);
  if (AUTH_ERRORS.has(name) || /credential|sso session|token.{0,100}expired/i.test(message)) {
    return new SforgeError(ErrorCode.CloudAuth, `${what}: ${message}`, {
      cause: error,
      hint: 'Sign in to AWS (e.g. `aws sso login`, or set AWS_PROFILE) and try again.',
    });
  }
  if (name === 'AccessDenied' || name === 'AccessDeniedException') {
    return new SforgeError(ErrorCode.CloudAuth, `${what}: access denied (${message})`, {
      cause: error,
      hint: 'The AWS identity in use lacks a permission this operation needs.',
    });
  }
  return new SforgeError(code, `${what}: ${message}`, { cause: error, details: { error: name } });
}
