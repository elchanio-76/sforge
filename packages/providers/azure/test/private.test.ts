import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ErrorCode, createLogger, validateConfig } from '@staticforge/core';
import { RECORDS_MODULE_DIR, createCloudflareDns } from '@staticforge/cloudflare';
import type { BuildManifest } from '@staticforge/provider-api';
import {
  DENIED_PAGE,
  FREE_MEMBER_LIMIT,
  SWA_CONFIG_LIMIT,
  createAzureDeployer,
  createAzureIacProfile,
  createAzureUserAdmin,
  describePrivateDomain,
  generateStaticWebAppConfig,
} from '../src/index.js';
import { azureConfig, fakeAzure, fakeUploader, outputs, site, writeBuild } from './fakes.js';

const logger = createLogger({ level: 'silent' });
const ZONE_ID = '9cb70fa80e764481efbd93d9cc565753';

interface Route {
  route: string;
  headers?: Record<string, string>;
  allowedRoles?: string[];
  statusCode?: number;
}

function manifest(files: Record<string, 'immutable' | 'revalidate'>): BuildManifest {
  return {
    version: 1,
    files: Object.fromEntries(
      Object.entries(files).map(([path, cache]) => [path, { sha256: 'x', size: 10, cache }]),
    ),
  };
}

const siteConfig = validateConfig({
  site: { title: 'Docs', baseUrl: 'https://docs.example.com' },
});

describe('staticwebapp.config.json of a private target', () => {
  const files = manifest({
    'index.html': 'revalidate',
    '404.html': 'revalidate',
    'search/index.html': 'revalidate',
    'assets/site.4f2a.css': 'immutable',
    'images/a.1.avif': 'immutable',
  });

  it('requires the member role on every route, with the catch-all last', () => {
    const { config } = generateStaticWebAppConfig(siteConfig, files, { providers: ['aad'] });
    const routes = config.routes as Route[];
    expect(routes[0]).toEqual({ route: '/.auth/login/github', statusCode: 404 });
    expect(routes[1]).toEqual({ route: `/${DENIED_PAGE}`, allowedRoles: ['authenticated'] });
    expect(routes.at(-1)).toEqual({ route: '/*', allowedRoles: ['member'] });
    // Only the first matching route applies: a header route without roles would let visitors in.
    for (const route of routes.slice(2)) expect(route.allowedRoles).toEqual(['member']);
    expect(routes.some((r) => r.route === '/search/*')).toBe(true);
    expect(routes.some((r) => r.headers?.['Cache-Control']?.includes('immutable'))).toBe(true);
  });

  it('sends visitors to sign in, and signed-in strangers to the denied page', () => {
    const { config } = generateStaticWebAppConfig(siteConfig, files, {
      providers: ['github', 'aad'],
    });
    expect(config.responseOverrides).toEqual({
      '401': {
        redirect: '/.auth/login/github?post_login_redirect_uri=.referrer',
        statusCode: 302,
      },
      '403': { rewrite: `/${DENIED_PAGE}`, statusCode: 403 },
      '404': { rewrite: '/404.html', statusCode: 404 },
    });
    expect((config.routes as Route[]).filter((r) => r.statusCode === 404)).toEqual([]);
    expect((config.globalHeaders as Record<string, string>)['Cache-Control']).toBe(
      'private, max-age=0, must-revalidate',
    );
  });

  it('keeps the access rules within the size limit, dropping cache rules first', () => {
    // A directory mixing both cache classes: each fingerprinted file needs its own rule.
    const many: Record<string, 'immutable' | 'revalidate'> = { 'assets/plain.js': 'revalidate' };
    for (let i = 0; i < 2000; i++) many[`assets/f.${i}.js`] = 'immutable';
    const generated = generateStaticWebAppConfig(siteConfig, manifest(many), {
      providers: ['aad'],
    });
    expect(generated.json.length).toBeLessThan(SWA_CONFIG_LIMIT);
    expect(generated.droppedRoutes).toBeGreaterThan(0);
    const routes = generated.config.routes as Route[];
    expect(routes.at(-1)).toEqual({ route: '/*', allowedRoles: ['member'] });
    expect(routes.every((r) => r.allowedRoles !== undefined || r.statusCode === 404)).toBe(true);
  });
});

function setup(target: Record<string, unknown>) {
  const azure = fakeAzure();
  const config = azureConfig(target);
  const context = {
    rootDir: mkdtempSync(join(tmpdir(), 'sforge-azure-root-')),
    config,
    targetName: 'prod',
    target: config.targets.prod!,
    outputs,
    env: { AZURE_SUBSCRIPTION_ID: '07be2078-a22e-42b2-a654-91c56c8ebcdd' },
    logger,
  };
  return { azure, context };
}

describe('Azure deployer for a private target', () => {
  it('adds the denied page and the access rules', async () => {
    const { azure, context } = setup({ auth: {} });
    const { uploader, uploads } = fakeUploader(azure);
    const deployer = createAzureDeployer(context, azure.clients, {
      uploader,
      pollIntervalMs: 1,
      readyTimeoutMs: 200,
    });
    const result = await deployer.deploy({ buildDir: writeBuild(site), gitSha: 'abc1234' });
    expect(result.uploaded).toBe(Object.keys(site).length + 2);
    const denied = uploads[0]!.files[DENIED_PAGE]!;
    expect(denied).toContain('<html lang="en">');
    expect(denied).toContain('/.auth/logout');
    const config = JSON.parse(uploads[0]!.files['staticwebapp.config.json']!);
    expect(config.routes.at(-1)).toEqual({ route: '/*', allowedRoles: ['member'] });
  });

  it("refuses the project's own staticwebapp.config.json", async () => {
    const { azure, context } = setup({ auth: {} });
    const { uploader, uploads } = fakeUploader(azure);
    const deployer = createAzureDeployer(context, azure.clients, { uploader });
    await expect(
      deployer.deploy({
        buildDir: writeBuild({ ...site, 'staticwebapp.config.json': '{}' }),
        gitSha: 'abc1234',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.ConfigInvalid });
    expect(uploads).toEqual([]);
  });
});

describe('Azure users', () => {
  it('invites with a link Static Web Apps creates, for the first provider by default', async () => {
    const { azure, context } = setup({ auth: { providers: ['aad', 'github'] } });
    const users = createAzureUserAdmin(context, azure.clients);
    expect(await users.invite({ user: 'ana@example.com' })).toEqual({
      user: 'ana@example.com',
      provider: 'aad',
      emailed: false,
      invitationUrl: 'https://lemon-bush-0123456ab.5.azurestaticapps.net/.auth/invitations/abc',
      expiresAt: '2026-11-03T12:00:00.000Z',
    });
    await users.invite({ user: 'octocat', provider: 'github', expiresHours: 24 });
    expect(azure.invitations).toEqual([
      {
        domain: 'lemon-bush-0123456ab.5.azurestaticapps.net',
        provider: 'aad',
        userDetails: 'ana@example.com',
        roles: 'member',
        numHoursToExpiration: 168,
      },
      {
        domain: 'lemon-bush-0123456ab.5.azurestaticapps.net',
        provider: 'github',
        userDetails: 'octocat',
        roles: 'member',
        numHoursToExpiration: 24,
      },
    ]);
  });

  it('invites on the custom domain when there is one', async () => {
    const { azure, context } = setup({ auth: {} });
    const users = createAzureUserAdmin(
      { ...context, outputs: { ...outputs, domain: 'docs.example.com' } },
      azure.clients,
    );
    await users.invite({ user: 'ana@example.com' });
    expect(azure.invitations[0]).toMatchObject({ domain: 'docs.example.com' });
  });

  it('refuses unknown providers, bad expiries, existing users and the 26th user', async () => {
    const { azure, context } = setup({ auth: {} });
    const users = createAzureUserAdmin(context, azure.clients);
    await expect(users.invite({ user: 'octocat', provider: 'github' })).rejects.toMatchObject({
      code: ErrorCode.Usage,
    });
    await expect(users.invite({ user: 'octocat' })).rejects.toMatchObject({
      code: ErrorCode.Usage,
    });
    await expect(users.invite({ user: 'a@example.com', expiresHours: 200 })).rejects.toMatchObject({
      code: ErrorCode.Usage,
    });
    azure.users = [
      {
        provider: 'aad',
        userId: 'u0',
        displayName: 'A@example.com',
        roles: 'anonymous,authenticated,member',
      },
    ];
    await expect(users.invite({ user: 'a@example.com' })).rejects.toMatchObject({
      code: ErrorCode.UserExists,
    });
    azure.users = Array.from({ length: FREE_MEMBER_LIMIT }, (_, i) => ({
      provider: 'aad',
      userId: `u${i}`,
      displayName: `user${i}@example.com`,
      roles: 'authenticated,member',
    }));
    await expect(users.invite({ user: 'new@example.com' })).rejects.toMatchObject({
      code: ErrorCode.UserLimit,
    });
    expect(azure.invitations).toEqual([]);
  });

  it('lists members only and removes them', async () => {
    const { azure, context } = setup({ auth: { providers: ['aad', 'github'] } });
    azure.users = [
      {
        provider: 'aad',
        userId: 'u1',
        displayName: 'ana@example.com',
        roles: 'authenticated,member',
      },
      {
        provider: 'github',
        userId: 'u2',
        displayName: 'octocat',
        roles: 'anonymous,authenticated',
      },
    ];
    const users = createAzureUserAdmin(context, azure.clients);
    expect(await users.list()).toEqual([{ id: 'u1', name: 'ana@example.com', provider: 'aad' }]);
    expect(await users.remove('ANA@example.com')).toBe(true);
    expect(azure.deletedUsers).toEqual(['aad/u1']);
    expect(await users.remove('octocat')).toBe(false);
  });

  it('refuses public targets', async () => {
    const { azure, context } = setup({});
    await expect(createAzureUserAdmin(context, azure.clients).list()).rejects.toMatchObject({
      code: ErrorCode.Unsupported,
    });
  });
});

describe('Azure profile for private domains', () => {
  function prepare(
    target: Record<string, unknown>,
    cname?: Parameters<typeof createAzureIacProfile>[1],
  ) {
    const azure = fakeAzure();
    const config = azureConfig(target);
    const profile = createAzureIacProfile(azure.clients, cname);
    return profile.prepare({
      rootDir: mkdtempSync(join(tmpdir(), 'sforge-azure-iac-')),
      config,
      targetName: 'prod',
      target: config.targets.prod!,
      env: { CLOUDFLARE_API_TOKEN: 'token' },
      logger,
      dns: createCloudflareDns(),
    });
  }

  it('publishes only the TXT validation record, after the domain yields its token', async () => {
    const prepared = await prepare({
      domain: 'intra.docs.example.com',
      privateDns: true,
      auth: { providers: ['github'] },
      dns: { provider: 'cloudflare', zone: 'example.com', zoneId: ZONE_ID },
    });
    expect(prepared.spec.module.inputs).toMatchObject({
      private_dns: true,
      auth_provider: 'github',
    });
    expect(prepared.spec.module.inputs).not.toHaveProperty('dns_ready');
    expect(prepared.spec.additionalModules?.map((m) => [m.name, m.dir, m.inputs.records])).toEqual([
      ['dns_validation', RECORDS_MODULE_DIR, { ref: 'module.site.dns_validation_records' }],
    ]);
    expect(prepared.prePhase?.targets).toEqual([
      'module.site.azurerm_static_web_app.site',
      'module.site.azurerm_static_web_app_custom_domain.site',
      'module.dns_validation',
    ]);
    expect(prepared.spec.outputs).toEqual(
      expect.arrayContaining(['validation_records', 'dns_private_records', 'sign_in_url']),
    );
  });

  it('prints the TXT record and waits for it without a DNS provider', async () => {
    const asked: string[] = [];
    const prepared = await prepare(
      { domain: 'intra.docs.example.com', privateDns: true, auth: {} },
      {
        cname: {
          nameservers: async () => ['ns1.example.net'],
          cname: async () => undefined,
          txt: async (name) => {
            asked.push(name);
            return ['tok3n'];
          },
        },
      },
    );
    const records = [{ name: '_dnsauth.intra.docs.example.com', type: 'TXT', value: 'tok3n' }];
    expect(prepared.prePhase?.describe({ validation_records: records })).toBe(
      'Create this DNS record in the public zone to validate the domain (provisioning waits until it resolves):\n' +
        '  _dnsauth.intra.docs.example.com TXT "tok3n"',
    );
    expect(describePrivateDomain({ validation_records: [] })).toBeUndefined();
    await prepared.prePhase?.wait?.({ validation_records: records }, logger);
    expect(asked).toEqual(['_dnsauth.intra.docs.example.com']);
  });
});
