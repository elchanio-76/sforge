import { randomBytes } from 'node:crypto';
import {
  DescribeKeyValueStoreCommand,
  GetKeyCommand,
  UpdateKeysCommand,
} from '@aws-sdk/client-cloudfront-keyvaluestore';
import { PutParameterCommand } from '@aws-sdk/client-ssm';
import type { AwsClients } from './clients.js';
import { errorName } from './clients.js';

/** The KVS key the router reads the session cookie key from. */
export const SESSION_KEY = 'auth:key';
/** The value OpenTofu/Terraform seeds before sforge writes a real key. */
const UNSET = 'none';

/** Where a private target keeps its session key: the router's copy and the Lambda's. */
export interface SessionKeyLocation {
  kvsArn: string;
  /** SSM SecureString parameter read by the sign-in Lambda. */
  parameter: string;
  region: string;
}

/** The location from a target's outputs; undefined for a public target. */
export function sessionKeyLocation(
  outputs: Record<string, unknown>,
  region: string,
): SessionKeyLocation | undefined {
  const { kvs_arn: kvsArn, auth_key_parameter: parameter } = outputs;
  if (typeof kvsArn !== 'string' || typeof parameter !== 'string') return undefined;
  return { kvsArn, parameter, region };
}

/**
 * Write a new random key, which signs everyone out: the Lambda's copy first,
 * then the router's. Between the two writes (and while the KVS change reaches
 * every edge, seconds) a sign-in may have to be repeated.
 */
export async function rotateSessionKey(
  clients: AwsClients,
  location: SessionKeyLocation,
): Promise<void> {
  const key = randomBytes(32).toString('hex');
  await clients.ssm(location.region).send(
    new PutParameterCommand({
      Name: location.parameter,
      Value: key,
      Type: 'SecureString',
      Overwrite: true,
    }),
  );
  const kvs = clients.kvs();
  const { ETag } = await kvs.send(new DescribeKeyValueStoreCommand({ KvsARN: location.kvsArn }));
  await kvs.send(
    new UpdateKeysCommand({
      KvsARN: location.kvsArn,
      IfMatch: ETag,
      Puts: [{ Key: SESSION_KEY, Value: key }],
    }),
  );
}

/** Create the key once, after the first apply. True when it was created. */
export async function seedSessionKey(
  clients: AwsClients,
  location: SessionKeyLocation,
): Promise<boolean> {
  let current: string | undefined;
  try {
    current = (
      await clients.kvs().send(new GetKeyCommand({ KvsARN: location.kvsArn, Key: SESSION_KEY }))
    ).Value;
  } catch (error) {
    if (errorName(error) !== 'ResourceNotFoundException') throw error;
  }
  if (current !== undefined && current !== UNSET) return false;
  await rotateSessionKey(clients, location);
  return true;
}
