import { describe, expect, it } from 'vitest';
import { ErrorCode, createLogger } from '@staticforge/core';
import type { DnsProfile, IacSpec, PreparedTarget, ProfileInput } from '@staticforge/iac';
import {
  GoogleApiError,
  createFirebaseIacProfile,
  describeRecords,
  siteId,
  stateLocation,
} from '../src/index.js';
import { type FakeFirebase, PROJECT, fakeFirebase, firebaseConfig } from './fakes.js';

const logger = createLogger({ level: 'silent' });

const fakeDns: DnsProfile = {
  provider: 'cloudflare',
  prepare: async () => ({
    requiredProviders: { cloudflare: { source: 'cloudflare/cloudflare', version: '>= 5.0' } },
    providers: {},
    records: (name, records) => ({ name, dir: '/records', inputs: { records } }),
  }),
};

const CLOUDFLARE = { provider: 'cloudflare', zone: 'example.com', zoneId: 'a'.repeat(32) };
const WITH_DOMAIN = { domain: 'firebase.example.com', dns: CLOUDFLARE };

function prepare(
  target: Record<string, unknown> = {},
  overrides: Partial<ProfileInput> & { fake?: FakeFirebase } = {},
): Promise<PreparedTarget> {
  const { fake = fakeFirebase(), ...rest } = overrides;
  const config = firebaseConfig(target);
  return createFirebaseIacProfile(fake.clients, {
    pollIntervalMs: 1,
    ownershipTimeoutMs: 20,
    certificateTimeoutMs: 20,
  }).prepare({
    rootDir: '/nowhere',
    config,
    targetName: 'prod',
    target: config.targets.prod!,
    env: {},
    logger,
    purpose: 'provision',
    dns: fakeDns,
    ...rest,
  });
}

const moduleNames = (spec: IacSpec) => (spec.additionalModules ?? []).map((m) => m.name);

describe('names', () => {
  it('derives the site ID from the project name and target', () => {
    const target = firebaseConfig().targets.prod as never;
    expect(siteId(target, 'docs', 'prod')).toBe('docs-prod');
  });

  it('prefers the configured site ID', () => {
    const target = firebaseConfig({ site: 'my-site' }).targets.prod as never;
    expect(siteId(target, 'docs', 'prod')).toBe('my-site');
  });

  it('shortens long names to the 30 characters Firebase allows, keeping them distinct', () => {
    const target = firebaseConfig().targets.prod as never;
    const a = siteId(target, 'a-very-long-project-name-for-a-site', 'production');
    const b = siteId(target, 'a-very-long-project-name-for-a-site', 'staging');
    expect(a).toHaveLength(30);
    expect(a).toMatch(/^[a-z0-9][a-z0-9-]{2,28}[a-z0-9]$/);
    expect(a).not.toBe(b);
  });

  it('pads names Firebase would find too short', () => {
    const target = firebaseConfig().targets.prod as never;
    expect(siteId(target, 'a', 'b')).toBe('a-b-site');
  });

  it('puts state in a bucket of the project, under the site and target', () => {
    const target = firebaseConfig().targets.prod as never;
    expect(stateLocation(target, 'docs', 'prod')).toEqual({
      bucket: `sforge-state-${PROJECT}`,
      prefix: 'docs/prod',
    });
    const own = firebaseConfig({ state: { bucket: 'my-state' } }).targets.prod as never;
    expect(stateLocation(own, 'docs', 'prod').bucket).toBe('my-state');
  });
});

describe('the workspace', () => {
  it('uses the gcs backend and the site module', async () => {
    const { spec, state } = await prepare();
    expect(spec.backend).toEqual({
      type: 'gcs',
      config: { bucket: `sforge-state-${PROJECT}`, prefix: 'docs/prod' },
    });
    expect(spec.module.inputs).toEqual({ project: PROJECT, site_id: 'docs-prod', domain: null });
    expect(state.description).toBe(`gs://sforge-state-${PROJECT}/docs/prod`);
    expect(state.exists).toBe(true);
  });

  it('bills calls to the project, which is what Firebase resources need', async () => {
    const { spec } = await prepare();
    const provider = { project: PROJECT, user_project_override: true, billing_project: PROJECT };
    expect(spec.providers.google).toEqual([provider]);
    expect(spec.providers['google-beta']).toEqual([provider]);
  });

  it('bootstraps state in the configured location, under its own prefix', async () => {
    const { state } = await prepare({ state: { location: 'europe-north1' } });
    expect(state.bootstrap.module.inputs).toEqual({
      project: PROJECT,
      bucket: `sforge-state-${PROJECT}`,
      location: 'europe-north1',
    });
    expect(state.bootstrap.backend.config).toMatchObject({ prefix: '_sforge/state-bootstrap' });
  });

  it('reports a missing state bucket', async () => {
    const fake = fakeFirebase();
    fake.bucket.exists = false;
    expect((await prepare({}, { fake })).state.exists).toBe(false);
  });

  it('reports a refused state bucket as a sign-in problem', async () => {
    const fake = fakeFirebase();
    fake.bucket.error = new GoogleApiError('denied', 403);
    await expect(prepare({}, { fake })).rejects.toMatchObject({ code: ErrorCode.CloudAuth });
  });

  it('touches nothing in the cloud when only reading outputs (a deploy in CI)', async () => {
    const fake = fakeFirebase();
    fake.signIn.error = new Error('no sign-in needed');
    fake.bucket.error = new Error('no bucket check needed');
    const prepared = await prepare(WITH_DOMAIN, { fake, purpose: 'outputs' });
    expect(prepared.state.exists).toBe(true);
    expect(prepared.imports).toBeUndefined();
  });
});

describe('private targets', () => {
  it('refuses sign-in, which Firebase Hosting cannot do', async () => {
    await expect(prepare({ auth: { providers: ['aad'] } })).rejects.toMatchObject({
      code: ErrorCode.Unsupported,
    });
  });

  it('refuses private DNS, which Firebase Hosting cannot use', async () => {
    await expect(prepare({ ...WITH_DOMAIN, privateDns: true })).rejects.toMatchObject({
      code: ErrorCode.Unsupported,
    });
  });
});

describe('a project that already uses Firebase', () => {
  it('adopts it instead of adding Firebase a second time', async () => {
    const fake = fakeFirebase();
    fake.isFirebase = true;
    expect((await prepare({}, { fake })).imports).toEqual([
      { to: 'module.site.google_firebase_project.this', id: PROJECT },
    ]);
  });

  it('shows the adoption in a plan too', async () => {
    const fake = fakeFirebase();
    fake.isFirebase = true;
    expect((await prepare({}, { fake, purpose: 'plan' })).imports).toHaveLength(1);
  });

  it('adopts nothing in a project without it', async () => {
    expect((await prepare()).imports).toBeUndefined();
  });

  it('adopts nothing for status and destroy', async () => {
    const fake = fakeFirebase();
    fake.isFirebase = true;
    const config = firebaseConfig();
    const prepared = await createFirebaseIacProfile(fake.clients).prepare({
      rootDir: '/nowhere',
      config,
      targetName: 'prod',
      target: config.targets.prod!,
      env: {},
      logger,
    });
    expect(prepared.imports).toBeUndefined();
  });
});

describe('a custom domain', () => {
  it('creates the domain first, then the records it names', async () => {
    const { spec, prePhase, expectedDrift } = await prepare(WITH_DOMAIN);
    expect(prePhase?.targets).toEqual(['module.site.google_firebase_hosting_custom_domain.this']);
    expect(moduleNames(spec)).toEqual(['dns_records']);
    expect(spec.additionalModules?.[0]?.inputs.records).toEqual({
      ref: 'module.site.dns_records',
    });
    expect(expectedDrift).toEqual(['module.site.google_firebase_hosting_custom_domain.this[0]']);
  });

  it('prints nothing and does not wait when sforge manages the records', async () => {
    const { prePhase } = await prepare(WITH_DOMAIN);
    expect(prePhase?.describe({ dns_records: { a: { name: 'x', type: 'A', value: '1' } } })).toBe(
      undefined,
    );
    expect(prePhase?.wait).toBeUndefined();
  });

  it('prints the records and waits for them when the user manages DNS', async () => {
    const fake = fakeFirebase();
    fake.domain = { ownershipState: 'OWNERSHIP_ACTIVE', hostState: 'HOST_ACTIVE' };
    const { prePhase } = await prepare({ domain: 'firebase.example.com' }, { fake });
    const notice = prePhase?.describe({
      dns_records: {
        a: { name: 'firebase.example.com', type: 'A', value: '199.36.158.100' },
        b: { name: 'firebase.example.com', type: 'TXT', value: 'hosting-site=x' },
      },
    });
    expect(notice).toContain('firebase.example.com A 199.36.158.100');
    expect(notice).toContain('firebase.example.com TXT "hosting-site=x"');
    await expect(prePhase?.wait?.({}, logger)).resolves.toBeUndefined();
  });

  it('fails with what to do when the records never show up', async () => {
    const fake = fakeFirebase();
    fake.domain = { ownershipState: 'OWNERSHIP_PENDING', hostState: 'HOST_UNHOSTED' };
    const { prePhase } = await prepare({ domain: 'firebase.example.com' }, { fake });
    await expect(prePhase?.wait?.({}, logger)).rejects.toMatchObject({
      code: ErrorCode.DeployFailed,
    });
  });

  it('has nothing to print without records', () => {
    expect(describeRecords({})).toBeUndefined();
  });

  it('leaves the records out of a plan until the domain exists', async () => {
    // A map's keys must be known when planning, and there is no pre-phase in a plan.
    const fresh = await prepare(WITH_DOMAIN, { purpose: 'plan' });
    expect(moduleNames(fresh.spec)).toEqual([]);

    const fake = fakeFirebase();
    fake.domain = { hostState: 'HOST_ACTIVE' };
    const existing = await prepare(WITH_DOMAIN, { fake, purpose: 'plan' });
    expect(moduleNames(existing.spec)).toEqual(['dns_records']);
  });

  it('treats a domain it cannot read yet as not existing', async () => {
    const fake = fakeFirebase();
    fake.api.getCustomDomain = async () => {
      throw new GoogleApiError('the API is off', 403);
    };
    const { spec } = await prepare(WITH_DOMAIN, { fake, purpose: 'plan' });
    expect(moduleNames(spec)).toEqual([]);
  });

  it('checks the domain is in the zone', async () => {
    await expect(prepare({ domain: 'firebase.other.org', dns: CLOUDFLARE })).rejects.toMatchObject({
      code: ErrorCode.ConfigInvalid,
    });
  });

  it('needs a domain for dns', async () => {
    await expect(prepare({ dns: CLOUDFLARE })).rejects.toMatchObject({
      code: ErrorCode.ConfigInvalid,
    });
  });

  it('returns at once when the certificate is there', async () => {
    const fake = fakeFirebase();
    fake.domain = { cert: { state: 'CERT_ACTIVE' } };
    const { postApply } = await prepare(WITH_DOMAIN, { fake });
    await expect(postApply?.({}, logger)).resolves.toBeUndefined();
  });

  it('does not fail when the certificate takes long: the site works without the domain', async () => {
    const fake = fakeFirebase();
    fake.domain = { cert: { state: 'CERT_PREPARING' } };
    const { postApply } = await prepare(WITH_DOMAIN, { fake });
    const notices = await postApply?.({}, logger);
    expect(notices?.[0]).toContain('has not issued the certificate');
    expect(notices?.[0]).toContain('https://docs-prod.web.app');
  });

  it('has no pre-phase without a domain', async () => {
    const { prePhase, postApply, expectedDrift } = await prepare();
    expect(prePhase).toBeUndefined();
    expect(postApply).toBeUndefined();
    expect(expectedDrift).toBeUndefined();
  });
});

describe('the GitHub Actions identity', () => {
  const CI = {
    repo: 'acme/docs',
    environments: ['production'],
    subjectPrefix: 'repo:acme@1/docs@2',
  };

  it('adds the module and exports what the workflows need', async () => {
    const { spec } = await prepare({ ci: CI });
    expect(moduleNames(spec)).toEqual(['ci']);
    const ci = spec.additionalModules?.[0];
    expect(ci?.inputs).toMatchObject({
      subject_prefix: 'repo:acme@1/docs@2',
      environments: ['production'],
      state_bucket: `sforge-state-${PROJECT}`,
      state_prefix: 'docs/prod',
      // Through the module, so that the identity waits for the APIs it needs.
      project: { ref: 'module.site.project' },
    });
    expect(spec.additionalOutputs).toEqual({
      ci_workload_identity_provider: { ref: 'module.ci.workload_identity_provider' },
      ci_service_account: { ref: 'module.ci.service_account' },
    });
    expect(spec.requiredProviders.random).toBeDefined();
  });

  it('comes without the random provider when there is no identity', async () => {
    expect((await prepare()).spec.requiredProviders.random).toBeUndefined();
  });
});
