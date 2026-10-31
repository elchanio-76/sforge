import { createHash } from 'node:crypto';
import { get } from 'node:https';
import { fileURLToPath } from 'node:url';
import { ErrorCode, type FirebaseTargetConfig, SforgeError } from '@staticforge/core';
import {
  type IacBackend,
  type IacProfile,
  type IacSpec,
  type PreparedTarget,
  type ProfileInput,
  githubSubjectPrefix,
  iacRef,
  prepareDns,
  projectName,
  withDns,
} from '@staticforge/iac';
import {
  type FirebaseClients,
  type HostingCustomDomain,
  defaultClients,
  firebaseError,
} from './client.js';

/** Packaged HCL, next to src/ and dist/. */
const terraformDir = (path: string) =>
  fileURLToPath(new URL(`../terraform/${path}`, import.meta.url));

export const SITE_MODULE_DIR = terraformDir('modules/site');
export const CI_MODULE_DIR = terraformDir('modules/ci-oidc');
export const STATE_BOOTSTRAP_DIR = terraformDir('state-bootstrap');

const GOOGLE_PROVIDER = { source: 'hashicorp/google', version: '>= 7.0, < 9.0' };
const GOOGLE_BETA_PROVIDER = { source: 'hashicorp/google-beta', version: '>= 7.0, < 9.0' };
const RANDOM_PROVIDER = { source: 'hashicorp/random', version: '>= 3.6, < 4.0' };

/** Address of the resource that holds Firebase's records and states. */
const CUSTOM_DOMAIN = 'module.site.google_firebase_hosting_custom_domain.this';
/** Address of the resource that adds Firebase to the project. */
const FIREBASE_PROJECT = 'module.site.google_firebase_project.this';

const DOMAIN_POLL_MS = 15_000;
/** The certificate took over half an hour in the live runs; Firebase allows itself a day. */
const CERTIFICATE_TIMEOUT_MS = 45 * 60_000;
const OWNERSHIP_TIMEOUT_MS = 60 * 60_000;

export interface StateLocation {
  bucket: string;
  prefix: string;
}

/** `sforge-state-<project>`, prefix `<site>/<target>`. */
export function stateLocation(
  target: FirebaseTargetConfig,
  project: string,
  targetName: string,
): StateLocation {
  return {
    bucket: target.state.bucket ?? `sforge-state-${target.project}`,
    prefix: `${project}/${targetName}`,
  };
}

const SITE_LIMIT = 30;

/** `targets.<n>.site`, else `<project name>-<target>`, shortened with a hash to fit. */
export function siteId(target: FirebaseTargetConfig, project: string, targetName: string): string {
  if (target.site !== undefined) return target.site;
  const base = `${project}-${targetName}`;
  if (base.length < 4) return `${base}-site`;
  if (base.length <= SITE_LIMIT) return base;
  const hash = createHash('sha256').update(base).digest('hex').slice(0, 6);
  return `${base.slice(0, SITE_LIMIT - hash.length - 1).replace(/-+$/, '')}-${hash}`;
}

/**
 * Firebase Hosting has no sign-in gate. Failing here also protects a deploy: a target
 * someone believes is private must not go out public.
 */
export function assertPublic(target: FirebaseTargetConfig, name: string): void {
  if (target.auth !== undefined) {
    throw new SforgeError(
      ErrorCode.Unsupported,
      `targets.${name}.auth: Firebase Hosting cannot require sign-in, so this target would be public`,
      { hint: 'Remove auth, or use an AWS or Azure target for a private site.' },
    );
  }
  if (target.privateDns) {
    throw new SforgeError(
      ErrorCode.Unsupported,
      `targets.${name}.privateDns: Firebase Hosting needs public DNS records`,
      { hint: 'Remove privateDns, or use an AWS or Azure target for a private domain.' },
    );
  }
}

const gcsBackend = (bucket: string, prefix: string): IacBackend => ({
  type: 'gcs',
  config: { bucket, prefix },
});

/**
 * Firebase's resources must be billed to the project itself, and a user login has no
 * project of its own: see the provider's "User Project Overrides".
 */
const googleProvider = (project: string) => ({
  project,
  user_project_override: true,
  billing_project: project,
});

function withCiIdentity(
  spec: IacSpec,
  ci: NonNullable<FirebaseTargetConfig['ci']>,
  site: { project: string; name: string; location: StateLocation; subjectPrefix: string },
): IacSpec {
  return {
    ...spec,
    requiredProviders: { ...spec.requiredProviders, random: RANDOM_PROVIDER },
    providers: { ...spec.providers, random: [{}] },
    additionalModules: [
      ...(spec.additionalModules ?? []),
      {
        name: 'ci',
        dir: CI_MODULE_DIR,
        inputs: {
          name: site.project,
          target: site.name,
          // The output waits for the APIs (IAM, STS) that the identity needs.
          project: iacRef('module.site.project'),
          repo: ci.repo,
          subject_prefix: site.subjectPrefix,
          branches: ci.branches,
          environments: ci.environments,
          pull_requests: ci.pullRequests,
          state_bucket: site.location.bucket,
          state_prefix: site.location.prefix,
        },
      },
    ],
    additionalOutputs: {
      ...spec.additionalOutputs,
      ci_workload_identity_provider: iacRef('module.ci.workload_identity_provider'),
      ci_service_account: iacRef('module.ci.service_account'),
    },
  };
}

/** Instructions for the records the user must create (no DNS provider). */
export function describeRecords(outputs: Record<string, unknown>): string | undefined {
  const records = Object.values(
    (outputs.dns_records ?? {}) as Record<string, { name: string; type: string; value: string }>,
  );
  if (records.length === 0) return undefined;
  return [
    'Create this DNS record (provisioning waits until Firebase sees it):',
    ...records.map((r) => `  ${r.name} ${r.type} ${r.type === 'TXT' ? `"${r.value}"` : r.value}`),
  ].join('\n');
}

/**
 * Whether the domain answers over HTTPS with a valid certificate. Any status will do:
 * a site with nothing deployed yet answers 404.
 */
export function answersOverHttps(domain: string): Promise<boolean> {
  return new Promise((resolve) => {
    const request = get(`https://${domain}/`, { agent: false, timeout: 15_000 }, (response) => {
      response.resume();
      resolve(true);
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

/**
 * Firebase wants different records at the zone apex, and they could not be verified: the
 * subdomain CNAME is what sforge computes. Without a DNS zone to compare with, a name of two
 * labels is taken to be an apex.
 */
function assertNotApex(target: FirebaseTargetConfig, name: string): void {
  const domain = target.domain;
  if (domain === undefined) return;
  const apex = target.dns !== undefined ? domain === target.dns.zone : domain.split('.').length < 3;
  if (apex) {
    throw new SforgeError(
      ErrorCode.Unsupported,
      `targets.${name}.domain ${domain} is the apex of its zone, which Firebase targets do not support yet`,
      { hint: `Use a subdomain such as www.${domain}.` },
    );
  }
}

export interface FirebaseIacOptions {
  /** Milliseconds between checks of the custom domain (tests). */
  pollIntervalMs?: number;
  ownershipTimeoutMs?: number;
  certificateTimeoutMs?: number;
  /** Whether the domain answers over HTTPS (tests). */
  httpsProbe?: (domain: string) => Promise<boolean>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll the custom domain until `done`; false when `timeoutMs` passes first. */
async function pollDomain(
  read: () => Promise<HostingCustomDomain | undefined>,
  done: (domain: HostingCustomDomain) => boolean,
  timeoutMs: number,
  intervalMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const domain = await read();
    if (domain !== undefined && done(domain)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

export function createFirebaseIacProfile(
  clients: FirebaseClients = defaultClients(),
  options: FirebaseIacOptions = {},
): IacProfile {
  const pollMs = options.pollIntervalMs ?? DOMAIN_POLL_MS;
  return {
    provider: 'firebase',
    async prepare(input: ProfileInput): Promise<PreparedTarget> {
      const target = input.target as FirebaseTargetConfig;
      const name = input.targetName;
      assertPublic(target, name);
      assertNotApex(target, name);

      const dns = await prepareDns(input, target.domain === undefined ? [] : [target.domain]);
      const project = projectName(input.config);
      const outputsOnly = input.purpose === 'outputs';
      const location = stateLocation(target, project, name);
      const site = siteId(target, project, name);
      const hosting = clients.hosting(target.project);
      const readDomain = () => hosting.getCustomDomain(target.project, site, target.domain!);

      let exists = true;
      if (!outputsOnly) {
        await clients.assertSignedIn(target.project);
        try {
          exists = await clients.bucketExists(target.project, location.bucket);
        } catch (error) {
          throw firebaseError(
            error,
            `Could not check the state bucket ${location.bucket}`,
            ErrorCode.CloudAuth,
          );
        }
      }

      const base: IacSpec = {
        requiredProviders: { google: GOOGLE_PROVIDER, 'google-beta': GOOGLE_BETA_PROVIDER },
        providers: {
          google: [googleProvider(target.project)],
          'google-beta': [googleProvider(target.project)],
        },
        module: {
          name: 'site',
          dir: SITE_MODULE_DIR,
          inputs: { project: target.project, site_id: site, domain: target.domain ?? null },
        },
        outputs: ['project', 'site_id', 'default_host_name', 'url', 'domain', 'dns_records'],
        backend: gcsBackend(location.bucket, location.prefix),
      };
      let spec =
        dns !== undefined
          ? withDns(base, dns, [
              { name: 'dns_records', records: iacRef('module.site.dns_records') },
            ])
          : base;
      if (target.ci !== undefined) {
        const subjectPrefix = await githubSubjectPrefix(target.ci, {
          env: input.env,
          purpose: input.purpose,
        });
        spec = withCiIdentity(spec, target.ci, { project, name, location, subjectPrefix });
      }

      const bootstrap: IacSpec = {
        requiredProviders: { google: GOOGLE_PROVIDER },
        providers: { google: [googleProvider(target.project)] },
        module: {
          name: 'state',
          dir: STATE_BOOTSTRAP_DIR,
          inputs: {
            project: target.project,
            bucket: location.bucket,
            location: target.state.location,
          },
        },
        outputs: ['bucket'],
        backend: gcsBackend(location.bucket, '_sforge/state-bootstrap'),
      };

      // Adding Firebase twice is an error and it cannot be removed, so a project that has
      // it already is adopted. On a later run the block finds the same resource in state,
      // which is no change.
      const adopt =
        !outputsOnly &&
        (input.purpose === 'provision' || input.purpose === 'plan') &&
        (await clients.isFirebaseProject(target.project));

      return {
        spec,
        state: {
          id: `firebase-${target.project}-${location.bucket}`,
          description: `gs://${location.bucket}/${location.prefix}`,
          exists,
          bootstrap,
        },
        ...(adopt && { imports: [{ to: FIREBASE_PROJECT, id: target.project }] }),
        // Firebase keeps updating the domain's states and records on its own.
        ...(target.domain !== undefined && { expectedDrift: [`${CUSTOM_DOMAIN}[0]`] }),
        // Without a DNS provider the user creates the record, from what this prints.
        ...(target.domain !== undefined &&
          dns === undefined && {
            prePhase: {
              targets: [CUSTOM_DOMAIN],
              describe: describeRecords,
              wait: async (_outputs, logger) => {
                logger.info(`Waiting until Firebase sees the DNS record of ${target.domain}`);
                const seen = await pollDomain(
                  readDomain,
                  (d) => d.ownershipState === 'OWNERSHIP_ACTIVE' && d.hostState === 'HOST_ACTIVE',
                  options.ownershipTimeoutMs ?? OWNERSHIP_TIMEOUT_MS,
                  pollMs,
                );
                if (!seen) {
                  throw new SforgeError(
                    ErrorCode.DeployFailed,
                    `Firebase does not see the DNS record of ${target.domain} yet`,
                    {
                      hint: 'Check it, then run provision again. Name servers can take a while to catch up.',
                    },
                  );
                }
              },
            },
          }),
        ...(target.domain !== undefined && {
          postApply: async (_outputs, logger) => {
            const domain = target.domain!;
            const secure = options.httpsProbe ?? answersOverHttps;
            if (await secure(domain)) return;
            logger.info(`Waiting for the certificate of ${domain}`);
            // Asking the domain itself: the live runs served a valid certificate while
            // Firebase's API still did not report it as active.
            const deadline = Date.now() + (options.certificateTimeoutMs ?? CERTIFICATE_TIMEOUT_MS);
            while (Date.now() < deadline) {
              await sleep(pollMs);
              if (await secure(domain)) return;
            }
            const state = await readDomain().catch(() => undefined);
            // Not a failure: the site works at *.web.app, and Firebase keeps trying.
            return [
              `Firebase has not issued the certificate of ${domain} yet (host ${state?.hostState ?? 'unknown'}, ownership ${state?.ownershipState ?? 'unknown'}, certificate ${state?.cert?.state ?? 'unknown'}); it can take up to 24 hours. The site is already served at https://${site}.web.app.`,
            ];
          },
        }),
      };
    },
  };
}
