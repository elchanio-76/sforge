import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ErrorCode, createLogger, validateConfig } from '@staticforge/core';
import type { ProfileInput } from '@staticforge/iac';
import { createAzureIacProfile, historyBlobName, stateLocation } from '../src/index.js';
import { SUBSCRIPTION, azureConfig, fakeAzure } from './fakes.js';

const logger = createLogger({ level: 'silent' });

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

  it.each([
    ['domain', { domain: 'www.example.com' }],
    ['dns', { dns: { provider: 'cloudflare', zone: 'example.com' } }],
    ['ci', { ci: { repo: 'acme/docs' } }],
  ])('says %s arrives with milestone M9', async (_option, target) => {
    const { profile, request } = input(fakeAzure(), target);
    await expect(profile.prepare(request)).rejects.toMatchObject({
      code: ErrorCode.Unsupported,
      hint: expect.stringContaining('M9'),
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
