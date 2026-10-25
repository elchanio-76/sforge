import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ErrorCode, createLogger, validateConfig } from '@staticforge/core';
import { RECORDS_MODULE_DIR, createCloudflareDns } from '@staticforge/cloudflare';
import type { ProfileInput } from '@staticforge/iac';
import {
  CI_MODULE_DIR,
  createAzureIacProfile,
  describeCname,
  historyBlobName,
  stateLocation,
} from '../src/index.js';
import { SUBSCRIPTION, azureConfig, fakeAzure } from './fakes.js';

const logger = createLogger({ level: 'silent' });
const ZONE_ID = '9cb70fa80e764481efbd93d9cc565753';

function input(
  azure = fakeAzure(),
  target: Record<string, unknown> = {},
  extra: Partial<ProfileInput> = {},
) {
  const config = azureConfig(target);
  const profile = createAzureIacProfile(azure.clients);
  const request: ProfileInput = {
    rootDir: mkdtempSync(join(tmpdir(), 'sforge-azure-iac-')),
    config,
    targetName: 'prod',
    target: config.targets.prod!,
    env: {},
    logger,
    ...extra,
  };
  return { azure, profile, request };
}

describe('Azure IaC profile', () => {
  it('describes the Static Web App workspace and its state backend', async () => {
    const { profile, request } = input();
    const prepared = await profile.prepare(request);
    const { spec, state } = prepared;

    expect(spec.requiredProviders.azurerm!.source).toBe('hashicorp/azurerm');
    expect(spec.providers.azurerm![0]).toMatchObject({
      subscription_id: SUBSCRIPTION,
      storage_use_azuread: true,
      resource_provider_registrations: 'none',
      resource_providers_to_register: ['Microsoft.Web', 'Microsoft.Storage'],
    });
    expect(spec.module.inputs).toMatchObject({
      name: 'docs-example-com',
      target: 'prod',
      resource_group_name: 'docs-prod',
      create_resource_group: true,
      location: 'westeurope',
      sku: 'Free',
    });
    expect(spec.outputs).toContain('default_host_name');
    expect(spec.backend.type).toBe('azurerm');
    expect(spec.backend.config).toMatchObject({
      subscription_id: SUBSCRIPTION,
      resource_group_name: 'sforge-state',
      container_name: 'tfstate',
      key: 'docs-example-com/prod.tfstate',
      use_azuread_auth: true,
    });
    expect(spec.backend.config).not.toHaveProperty('access_key');
    expect(state.exists).toBe(true);
    expect(state.bootstrap.backend.config).toMatchObject({
      key: '_sforge/state-bootstrap.tfstate',
      storage_account_name: spec.backend.config.storage_account_name,
    });
    expect(state.bootstrap.requiredProviders).toHaveProperty('time');
    expect(prepared.preDestroyInputs).toBeUndefined();
  });

  it('names the state storage account after the subscription, within Azure’s rules', () => {
    const target = azureConfig().targets.prod! as Parameters<typeof stateLocation>[0];
    const a = stateLocation(target, SUBSCRIPTION, 'docs', 'prod');
    const b = stateLocation(target, SUBSCRIPTION.toUpperCase(), 'docs', 'prod');
    const other = stateLocation(target, '9e7f805a-621d-4b35-bc34-9f849cb15c01', 'docs', 'prod');
    expect(a.storageAccount).toMatch(/^[a-z0-9]{3,24}$/);
    expect(a.storageAccount).toBe(b.storageAccount);
    expect(a.storageAccount).not.toBe(other.storageAccount);
    expect(historyBlobName('docs', 'prod')).toBe('_sforge/docs/prod/versions.json');
  });

  it('honours configured state names', async () => {
    const { profile, request } = input(fakeAzure(), {
      state: { resourceGroup: 'rg-state', storageAccount: 'mystate123', container: 'states' },
    });
    const { spec } = await profile.prepare(request);
    expect(spec.backend.config).toMatchObject({
      resource_group_name: 'rg-state',
      storage_account_name: 'mystate123',
      container_name: 'states',
    });
  });

  it('prefers the configured subscription, then the environment, then the az login', async () => {
    const azure = fakeAzure();
    azure.azOutput = 'from-az';
    const configured = input(azure, { subscriptionId: '11111111-1111-4111-8111-111111111111' });
    expect(
      (
        await configured.profile.prepare({
          ...configured.request,
          env: { AZURE_SUBSCRIPTION_ID: 'x' },
        })
      ).spec.backend.config.subscription_id,
    ).toBe('11111111-1111-4111-8111-111111111111');

    const fromAzure = input(azure);
    const prepare = (env: NodeJS.ProcessEnv) =>
      fromAzure.profile.prepare({ ...fromAzure.request, env });
    expect(
      (await prepare({ AZURE_SUBSCRIPTION_ID: 'env-a', ARM_SUBSCRIPTION_ID: 'env-b' })).spec.backend
        .config.subscription_id,
    ).toBe('env-a');
    expect(
      (await prepare({ ARM_SUBSCRIPTION_ID: 'env-b' })).spec.backend.config.subscription_id,
    ).toBe('env-b');
    expect((await prepare({})).spec.backend.config.subscription_id).toBe('from-az');
  });

  it('asks for a login when no subscription can be found', async () => {
    const azure = fakeAzure();
    azure.azOutput = undefined;
    const { profile, request } = input(azure);
    await expect(profile.prepare(request)).rejects.toMatchObject({
      code: ErrorCode.CloudAuth,
      hint: expect.stringContaining('az login'),
    });
  });

  it('reports missing sign-in as SF_CLOUD_AUTH', async () => {
    const azure = fakeAzure();
    azure.signIn.error = Object.assign(new Error('Please run "az login"'), {
      name: 'CredentialUnavailableError',
    });
    const { profile, request } = input(azure);
    await expect(profile.prepare(request)).rejects.toMatchObject({ code: ErrorCode.CloudAuth });
  });

  it('knows whether the state storage exists', async () => {
    const azure = fakeAzure();
    azure.storage.account = false;
    const { profile, request } = input(azure);
    expect((await profile.prepare(request)).state.exists).toBe(false);
  });

  it('refuses a storage account that has no state container', async () => {
    const azure = fakeAzure();
    azure.storage.container = false;
    const { profile, request } = input(azure);
    await expect(profile.prepare(request)).rejects.toMatchObject({ code: ErrorCode.StateMissing });
  });

  it('maps a forbidden state account to SF_CLOUD_AUTH', async () => {
    const azure = fakeAzure();
    azure.storage.error = Object.assign(new Error('Forbidden'), {
      statusCode: 403,
      code: 'AuthorizationFailed',
    });
    const { profile, request } = input(azure);
    await expect(profile.prepare(request)).rejects.toMatchObject({ code: ErrorCode.CloudAuth });
  });

  it('only reads outputs without signing in or checking storage', async () => {
    const azure = fakeAzure();
    azure.storage.error = new Error('must not be called');
    const { profile, request } = input(azure, {}, { purpose: 'outputs' });
    const prepared = await profile.prepare(request);
    expect(prepared.state.exists).toBe(true);
    expect(azure.tokenCalls).toBe(0);
  });

  it('creates the custom domain after its CNAME in Cloudflare', async () => {
    const { profile, request } = input(
      fakeAzure(),
      {
        domain: 'azure.docs.example.com',
        dns: { provider: 'cloudflare', zone: 'example.com', zoneId: ZONE_ID },
      },
      { dns: createCloudflareDns(), env: { CLOUDFLARE_API_TOKEN: 'token' } },
    );
    const prepared = await profile.prepare(request);
    expect(prepared.spec.module.inputs).toMatchObject({
      domain: 'azure.docs.example.com',
      dns_ready: { ref: 'module.dns_routing.ids' },
    });
    expect(prepared.spec.requiredProviders).toHaveProperty('cloudflare');
    expect(prepared.spec.additionalModules).toEqual([
      {
        name: 'dns_routing',
        dir: RECORDS_MODULE_DIR,
        inputs: {
          zone_id: ZONE_ID,
          comment: 'staticforge docs-example-com/prod',
          records: { ref: 'module.site.dns_routing_records' },
        },
      },
    ]);
    // Azure refuses the domain until its CNAME resolves: app and CNAME first, then wait.
    expect(prepared.prePhase?.targets).toEqual([
      'module.site.azurerm_static_web_app.site',
      'module.dns_routing',
    ]);
    expect(prepared.prePhase?.describe({ dns_records: [] })).toBeUndefined();
  });

  it('prints the CNAME first when sforge does not manage the DNS', async () => {
    const { profile, request } = input(fakeAzure(), { domain: 'www.example.com' });
    const prepared = await profile.prepare(request);
    expect(prepared.spec.module.inputs).toMatchObject({ domain: 'www.example.com' });
    expect(prepared.spec.module.inputs).not.toHaveProperty('dns_ready');
    expect(prepared.prePhase?.targets).toEqual(['module.site.azurerm_static_web_app.site']);
    expect(
      prepared.prePhase?.describe({
        dns_records: [{ name: 'www.example.com', type: 'CNAME', value: 'x.azurestaticapps.net' }],
      }),
    ).toBe(
      'Create this DNS record (provisioning waits until it resolves):\n' +
        '  www.example.com CNAME x.azurestaticapps.net',
    );
    expect(describeCname({ dns_records: [] })).toBeUndefined();
  });

  it('waits for the CNAME to the app before adding the domain', async () => {
    const asked: string[] = [];
    const azure = fakeAzure();
    const { request } = input(azure, { domain: 'www.example.com' });
    const profile = createAzureIacProfile(azure.clients, {
      cname: {
        nameservers: async () => ['ns1.example.net'],
        cname: async (name) => {
          asked.push(name);
          return 'x.azurestaticapps.net';
        },
      },
    });
    const prepared = await profile.prepare(request);
    await prepared.prePhase?.wait?.({ default_host_name: 'x.azurestaticapps.net' }, logger);
    expect(asked).toEqual(['www.example.com']);
  });

  it.each([
    ['without a zone', { domain: 'example.com' }],
    [
      'equal to the zone',
      { domain: 'example.co.uk', dns: { provider: 'cloudflare', zone: 'example.co.uk' } },
    ],
  ])('refuses an apex domain (%s)', async (_case, target) => {
    const { profile, request } = input(fakeAzure(), target, { dns: createCloudflareDns() });
    await expect(profile.prepare(request)).rejects.toMatchObject({
      code: ErrorCode.Unsupported,
      message: expect.stringContaining('apex'),
      hint: expect.stringContaining('www.'),
    });
  });

  it('adds the GitHub Actions identity with access to its own state only', async () => {
    const { profile, request } = input(fakeAzure(), {
      ci: { repo: 'acme/docs', environments: ['production'] },
    });
    const { spec } = await profile.prepare(request);
    const location = spec.backend.config;
    expect(spec.requiredProviders).toHaveProperty('azuread.source', 'hashicorp/azuread');
    expect(spec.additionalModules).toEqual([
      {
        name: 'ci',
        dir: CI_MODULE_DIR,
        inputs: {
          name: 'docs-example-com',
          target: 'prod',
          subscription_id: SUBSCRIPTION,
          repo: 'acme/docs',
          branches: ['main'],
          environments: ['production'],
          pull_requests: true,
          resource_group_id: { ref: 'module.site.resource_group_id' },
          static_web_app_id: { ref: 'module.site.static_web_app_id' },
          state_container_id:
            `/subscriptions/${SUBSCRIPTION}/resourceGroups/sforge-state` +
            `/providers/Microsoft.Storage/storageAccounts/${String(location.storage_account_name)}` +
            '/blobServices/default/containers/tfstate',
          state_key: 'docs-example-com/prod.tfstate',
          history_prefix: '_sforge/docs-example-com/prod/',
        },
      },
    ]);
    expect(spec.additionalOutputs).toEqual({
      ci_client_id: { ref: 'module.ci.client_id' },
      ci_tenant_id: { ref: 'module.ci.tenant_id' },
      ci_subscription_id: { ref: 'module.ci.subscription_id' },
    });
  });

  it('keeps within Entra’s limit of federated logins', async () => {
    const branches = Array.from({ length: 20 }, (_, i) => `b${i}`);
    const { profile, request } = input(fakeAzure(), { ci: { repo: 'acme/docs', branches } });
    await expect(profile.prepare(request)).rejects.toMatchObject({
      code: ErrorCode.ConfigInvalid,
      message: expect.stringContaining('allows 21 branches, environments and pull requests'),
    });
  });

  it('rejects regions without Static Web Apps', async () => {
    const { profile, request } = input(fakeAzure(), { location: 'northeurope' });
    await expect(profile.prepare(request)).rejects.toMatchObject({
      code: ErrorCode.ConfigInvalid,
      hint: expect.stringContaining('westeurope'),
    });
  });

  it('accepts the Azure target fields in the config schema', () => {
    const config = validateConfig({
      site: { title: 'Docs', baseUrl: 'https://docs.example.com' },
      targets: {
        prod: {
          provider: 'azure',
          resourceGroup: 'rg',
          createResourceGroup: false,
          location: 'westeurope',
          sku: 'Standard',
        },
      },
    });
    expect(config.targets.prod).toMatchObject({ createResourceGroup: false, retainVersions: 10 });
  });
});
