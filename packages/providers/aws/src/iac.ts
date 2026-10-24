import { fileURLToPath } from 'node:url';
import {
  ListOpenIDConnectProviderTagsCommand,
  ListOpenIDConnectProvidersCommand,
} from '@aws-sdk/client-iam';
import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { type AwsTargetConfig, ErrorCode, SforgeError } from '@staticforge/core';
import {
  type IacBackend,
  type IacProfile,
  type IacSpec,
  type PreparedTarget,
  type ProfileInput,
  projectName,
} from '@staticforge/iac';
import { searchPaths, securityHeaders } from '@staticforge/provider-api';
import { type AwsClients, awsError, defaultClients, errorName, httpStatus } from './clients.js';

/** Packaged HCL, next to src/ and dist/. */
const terraformDir = (path: string) =>
  fileURLToPath(new URL(`../terraform/${path}`, import.meta.url));

export const SITE_MODULE_DIR = terraformDir('modules/site');
export const STATE_BOOTSTRAP_DIR = terraformDir('state-bootstrap');

const AWS_PROVIDER = { source: 'hashicorp/aws', version: '>= 6.0, < 7.0' };
const GITHUB_OIDC_HOST = 'token.actions.githubusercontent.com';

export interface StateLocation {
  bucket: string;
  region: string;
  key: string;
}

/** `sforge-state-<accountId>-<region>` unless configured, key `<site>/<target>.tfstate`. */
export function stateLocation(
  target: AwsTargetConfig,
  accountId: string,
  project: string,
  targetName: string,
): StateLocation {
  const region = target.state.region ?? target.region;
  return {
    bucket: target.state.bucket ?? `sforge-state-${accountId}-${region}`,
    region,
    key: `${project}/${targetName}.tfstate`,
  };
}

function s3Backend(location: StateLocation, kmsKeyArn: string | undefined): IacBackend {
  return {
    type: 's3',
    config: {
      bucket: location.bucket,
      key: location.key,
      region: location.region,
      encrypt: true,
      use_lockfile: true,
      ...(kmsKeyArn !== undefined && { kms_key_id: kmsKeyArn }),
    },
  };
}

async function accountId(clients: AwsClients, region: string): Promise<string> {
  try {
    const identity = await clients.sts(region).send(new GetCallerIdentityCommand({}));
    if (identity.Account === undefined) throw new Error('no account in the caller identity');
    return identity.Account;
  } catch (error) {
    throw awsError(error, 'Could not identify the AWS account', ErrorCode.CloudAuth);
  }
}

async function bucketExists(clients: AwsClients, bucket: string, region: string): Promise<boolean> {
  try {
    await clients.s3(region).send(new HeadBucketCommand({ Bucket: bucket }));
    return true;
  } catch (error) {
    const status = httpStatus(error);
    if (status === 404 || errorName(error) === 'NotFound' || errorName(error) === 'NoSuchBucket') {
      return false;
    }
    if (status === 403) {
      throw new SforgeError(
        ErrorCode.CloudAuth,
        `The state bucket ${bucket} exists but this AWS identity cannot access it`,
        {
          hint: 'Bucket names are global: if another account owns it, set targets.<name>.state.bucket.',
        },
      );
    }
    throw awsError(error, `Could not check the state bucket ${bucket}`, ErrorCode.CloudAuth);
  }
}

export interface OidcProviderChoice {
  create: boolean;
  arn?: string;
}

/**
 * The account's GitHub OIDC provider is shared: reuse an existing one, unless
 * this target created it (tagged `sforge:owner = <site>-<target>`), in which
 * case it stays managed here.
 */
export async function chooseOidcProvider(
  clients: AwsClients,
  owner: string,
): Promise<OidcProviderChoice> {
  try {
    const iam = clients.iam();
    const list = await iam.send(new ListOpenIDConnectProvidersCommand({}));
    const arn = list.OpenIDConnectProviderList?.map((p) => p.Arn).find(
      (a): a is string => a !== undefined && a.endsWith(`/${GITHUB_OIDC_HOST}`),
    );
    if (arn === undefined) return { create: true };
    const tags = await iam.send(
      new ListOpenIDConnectProviderTagsCommand({ OpenIDConnectProviderArn: arn }),
    );
    const ours = tags.Tags?.some((t) => t.Key === 'sforge:owner' && t.Value === owner) ?? false;
    return ours ? { create: true } : { create: false, arn };
  } catch (error) {
    throw awsError(error, 'Could not look up the GitHub OIDC provider', ErrorCode.CloudAuth);
  }
}

/** Instructions for DNS records the user must create (no Route 53 hosted zone). */
export function describeValidation(outputs: Record<string, unknown>): string | undefined {
  const records = outputs.validation_records as
    { name: string; type: string; value: string }[] | undefined;
  if (records === undefined || records.length === 0) return undefined;
  const lines = records.map((r) => `  ${r.name} ${r.type} ${r.value}`);
  return [
    'Create these DNS records to validate the certificate (provisioning waits until they resolve):',
    ...lines,
  ].join('\n');
}

export function createAwsIacProfile(clients: AwsClients = defaultClients()): IacProfile {
  return {
    provider: 'aws',
    async prepare(input: ProfileInput): Promise<PreparedTarget> {
      const target = input.target as AwsTargetConfig;
      const project = projectName(input.config);
      const id = `${project}-${input.targetName}`;
      const account = await accountId(clients, target.region);
      const location = stateLocation(target, account, project, input.targetName);
      const outputsOnly = input.purpose === 'outputs';
      const exists = outputsOnly
        ? true
        : await bucketExists(clients, location.bucket, location.region);

      if (target.previewDomain !== undefined && target.domain === undefined) {
        throw new SforgeError(
          ErrorCode.ConfigInvalid,
          `targets.${input.targetName}.previewDomain needs a domain`,
          {
            hint: 'PR previews are served from a wildcard certificate of the custom domain.',
          },
        );
      }

      const oidc =
        target.ci === undefined || outputsOnly ? undefined : await chooseOidcProvider(clients, id);
      const headers = securityHeaders(input.config);
      const tags = { 'sforge:managed-by': 'staticforge' };
      const inputs: Record<string, unknown> = {
        name: project,
        target: input.targetName,
        trailing_slash: input.config.build.trailingSlash,
        domain: target.domain ?? null,
        hosted_zone: target.hostedZone ?? null,
        preview_domain: target.previewDomain ?? null,
        logging: target.logging,
        waf_web_acl_arn: target.wafWebAclArn ?? null,
        force_destroy: false,
        security_headers: {
          content_security_policy: headers.contentSecurityPolicy,
          search_content_security_policy: headers.searchContentSecurityPolicy,
          hsts_max_age: headers.hsts?.maxAge ?? null,
          hsts_include_subdomains: headers.hsts?.includeSubDomains ?? false,
          hsts_preload: headers.hsts?.preload ?? false,
          referrer_policy: headers.referrerPolicy,
          frame_options: headers.frameOptions,
          permissions_policy: headers.permissionsPolicy,
        },
        search_paths: searchPaths(input.config),
        ci:
          target.ci === undefined
            ? null
            : {
                repo: target.ci.repo,
                branches: target.ci.branches,
                environments: target.ci.environments,
                pull_requests: target.ci.pullRequests,
                // Reading outputs never applies, so the choice does not matter there.
                create_oidc_provider: oidc?.create ?? false,
                oidc_provider_arn: oidc?.arn ?? null,
                state_bucket: location.bucket,
                state_key: location.key,
              },
        tags,
        ...input.inputs,
      };

      const defaultTags = [
        { tags: { ...tags, 'sforge:site': project, 'sforge:target': input.targetName } },
      ];
      const spec: IacSpec = {
        requiredProviders: { aws: AWS_PROVIDER },
        providers: {
          aws: [
            { region: target.region, default_tags: defaultTags },
            { alias: 'us_east_1', region: 'us-east-1', default_tags: defaultTags },
          ],
        },
        module: {
          name: 'site',
          dir: SITE_MODULE_DIR,
          inputs,
          providers: { aws: 'aws', 'aws.us_east_1': 'aws.us_east_1' },
        },
        outputs: [
          'bucket',
          'bucket_region',
          'distribution_id',
          'distribution_arn',
          'distribution_domain',
          'kvs_arn',
          'url',
          'preview_domain',
          'trailing_slash',
          'certificate_arn',
          'validation_records',
          'dns_records',
          'ci_role_arn',
          'oidc_provider_arn',
        ],
        backend: s3Backend(location, target.state.kmsKeyArn),
      };

      const bootstrap: IacSpec = {
        requiredProviders: { aws: AWS_PROVIDER },
        providers: { aws: [{ region: location.region, default_tags: [{ tags }] }] },
        module: {
          name: 'state',
          dir: STATE_BOOTSTRAP_DIR,
          inputs: { bucket_name: location.bucket, kms_key_arn: target.state.kmsKeyArn ?? null },
        },
        outputs: ['bucket', 'region'],
        backend: s3Backend(
          { ...location, key: '_sforge/state-bootstrap.tfstate' },
          target.state.kmsKeyArn,
        ),
      };

      return {
        spec,
        state: {
          id: `aws-${account}-${location.region}${target.state.bucket ? `-${target.state.bucket}` : ''}`,
          description: `s3://${location.bucket}/${location.key}`,
          exists,
          bootstrap,
        },
        preDestroyInputs: { force_destroy: true },
        // Deploys and rollbacks switch the active version with the SDK.
        expectedDrift: ['module.site.aws_cloudfrontkeyvaluestore_key.active'],
        ...(target.domain !== undefined &&
          target.hostedZone === undefined && {
            prePhase: {
              targets: ['module.site.aws_acm_certificate.site'],
              describe: describeValidation,
            },
          }),
      };
    },
  };
}
