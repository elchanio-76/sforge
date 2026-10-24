import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ErrorCode, SforgeError, createLogger } from '@staticforge/core';
import type { Deployer } from '@staticforge/provider-api';
import { type AzureDeployerOptions, createAzureDeployer } from '../src/index.js';
import {
  type FakeAzure,
  azureConfig,
  fakeAzure,
  fakeUploader,
  outputs,
  site,
  writeBuild,
} from './fakes.js';

const logger = createLogger({ level: 'silent' });

function setup(
  options: {
    target?: Record<string, unknown>;
    out?: Record<string, unknown>;
    uploader?: Parameters<typeof fakeUploader>[1];
    deployer?: AzureDeployerOptions;
  } = {},
) {
  const azure = fakeAzure();
  const config = azureConfig(options.target);
  const { uploader, uploads } = fakeUploader(azure, options.uploader);
  const deployer: Deployer = createAzureDeployer(
    {
      rootDir: mkdtempSync(join(tmpdir(), 'sforge-azure-root-')),
      config,
      targetName: 'prod',
      target: config.targets.prod!,
      outputs: options.out ?? outputs,
      env: { AZURE_SUBSCRIPTION_ID: '07be2078-a22e-42b2-a654-91c56c8ebcdd' },
      logger,
    },
    azure.clients,
    { uploader, pollIntervalMs: 1, readyTimeoutMs: 200, ...options.deployer },
  );
  return { azure, deployer, uploads };
}

const at = (n: number) => new Date(Date.UTC(2026, 9, 24, 12, n));

describe('Azure deployer', () => {
  it('uploads the published files to production and records the version', async () => {
    const { azure, deployer, uploads } = setup();
    const result = await deployer.deploy({
      buildDir: writeBuild(site),
      gitSha: 'abc1234',
      now: at(0),
    });

    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.environment).toBe('production');
    expect(uploads[0]!.token).toBe('SECRET-DEPLOYMENT-TOKEN');
    expect(Object.keys(uploads[0]!.files).sort()).toEqual([
      '404.html',
      'about/index.html',
      'assets/site.4f2a.css',
      'assets/site.css',
      'index.html',
      'staticwebapp.config.json',
    ]);
    expect(result).toMatchObject({
      provider: 'azure',
      versionId: '20261024T120000Z-abc1234',
      url: 'https://lemon-bush-0123456ab.5.azurestaticapps.net',
      preview: false,
      uploaded: 6,
      dryRun: false,
    });
    expect(azure.history.doc).toMatchObject({
      active: '20261024T120000Z-abc1234',
      versions: [{ id: '20261024T120000Z-abc1234', gitSha: 'abc1234', files: 6 }],
    });
  });

  it('never publishes .sforge/ or the token, and removes its staging copy', async () => {
    const { deployer, uploads } = setup();
    await deployer.deploy({ buildDir: writeBuild(site), gitSha: 'abc1234' });
    const files = Object.keys(uploads[0]!.files);
    expect(files.some((f) => f.startsWith('.sforge'))).toBe(false);
    expect(JSON.stringify(uploads[0]!.files)).not.toContain('SECRET-DEPLOYMENT-TOKEN');
    const staged = readdirSync(tmpdir()).filter(
      (n) => n.startsWith('sforge-azure-') && existsSync(join(tmpdir(), n, 'site')),
    );
    expect(staged).toEqual([]);
  });

  it('adds the generated staticwebapp.config.json', async () => {
    const { deployer, uploads } = setup();
    await deployer.deploy({
      buildDir: writeBuild(site, ['assets/site.4f2a.css']),
      gitSha: 'abc1234',
    });
    const config = JSON.parse(uploads[0]!.files['staticwebapp.config.json']!);
    expect(config.trailingSlash).toBe('auto');
    expect(config.responseOverrides['404']).toEqual({ rewrite: '/404.html', statusCode: 404 });
    expect(config.globalHeaders['X-Content-Type-Options']).toBe('nosniff');
    expect(config.routes).toContainEqual({
      route: '/assets/site.4f2a.css',
      headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
    });
  });

  it("keeps the project's own staticwebapp.config.json", async () => {
    const { deployer, uploads } = setup();
    await deployer.deploy({
      buildDir: writeBuild({ ...site, 'staticwebapp.config.json': '{"mine":true}' }),
      gitSha: 'abc1234',
    });
    expect(uploads[0]!.files['staticwebapp.config.json']).toBe('{"mine":true}');
  });

  it('deploys a preview to a named environment without touching the history', async () => {
    const { azure, deployer, uploads } = setup();
    const result = await deployer.deploy({ buildDir: writeBuild(site), preview: 'pr-42' });
    expect(uploads[0]!.environment).toBe('pr-42');
    expect(result).toMatchObject({
      versionId: 'pr-42',
      preview: true,
      url: 'https://lemon-bush-0123456ab-pr42.westeurope.5.azurestaticapps.net',
    });
    expect(azure.history.doc).toBeUndefined();
  });

  it('rejects invalid preview ids before uploading anything', async () => {
    const { deployer, uploads } = setup();
    await expect(
      deployer.deploy({ buildDir: writeBuild(site), preview: 'PR 1' }),
    ).rejects.toMatchObject({ code: ErrorCode.Usage });
    expect(uploads).toHaveLength(0);
  });

  it('computes the preview base URL for the build', () => {
    const { deployer } = setup();
    expect(deployer.previewBaseUrl?.('pr-42')).toBe(
      'https://lemon-bush-0123456ab-pr42.westeurope.5.azurestaticapps.net',
    );
  });

  it('does not call Azure on a dry run', async () => {
    const { azure, deployer, uploads } = setup();
    const result = await deployer.deploy({
      buildDir: writeBuild(site),
      dryRun: true,
      gitSha: 'abc1234',
    });
    expect(result).toMatchObject({ dryRun: true, uploaded: 6 });
    expect(uploads).toHaveLength(0);
    expect(azure.tokenCalls).toBe(0);
    expect(azure.secretCalls).toBe(0);
  });

  it('waits until the upload is live, ignoring a stale Ready build', async () => {
    const { azure, deployer } = setup({ uploader: { stale: true } });
    const pending = deployer.deploy({ buildDir: writeBuild(site), gitSha: 'abc1234' });
    await expect(pending).rejects.toMatchObject({
      code: ErrorCode.DeployFailed,
      message: expect.stringContaining('not live'),
    });
    expect(azure.history.doc).toBeUndefined();
  });

  it('fails when Azure reports the deployment as failed', async () => {
    const azure = fakeAzure();
    const config = azureConfig();
    const { uploader } = fakeUploader(azure);
    const deployer = createAzureDeployer(
      {
        rootDir: mkdtempSync(join(tmpdir(), 'sforge-azure-root-')),
        config,
        targetName: 'prod',
        target: config.targets.prod!,
        outputs,
        env: { AZURE_SUBSCRIPTION_ID: '07be2078-a22e-42b2-a654-91c56c8ebcdd' },
        logger,
      },
      azure.clients,
      {
        uploader: async (request) => {
          await uploader(request);
          azure.builds[0]!.status = 'Failed';
          return {};
        },
        pollIntervalMs: 1,
      },
    );
    await expect(deployer.deploy({ buildDir: writeBuild(site) })).rejects.toMatchObject({
      code: ErrorCode.DeployFailed,
      message: expect.stringContaining('failed'),
    });
    expect(azure.history.doc).toBeUndefined();
  });

  it('keeps only retainVersions entries and reports the rest as pruned', async () => {
    const { azure, deployer } = setup();
    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(
        await deployer.deploy({ buildDir: writeBuild(site), gitSha: `sha000${i}`, now: at(i) }),
      );
    }
    expect(azure.history.doc!.versions.map((v) => v.gitSha)).toEqual([
      'sha0003',
      'sha0002',
      'sha0001',
    ]);
    expect(results[3]!.pruned).toEqual(['20261024T120000Z-sha0000']);
    expect(results[3]!.previousVersionId).toBe('20261024T120200Z-sha0002');
  });

  it('retries the history update when another deploy changed it', async () => {
    const { azure, deployer } = setup();
    azure.history.conflicts = 2;
    await deployer.deploy({ buildDir: writeBuild(site), gitSha: 'abc1234', now: at(0) });
    expect(azure.history.doc!.versions).toHaveLength(1);
  });

  it('gives up after repeated history conflicts, saying the site is live', async () => {
    const { azure, deployer } = setup();
    azure.history.conflicts = 10;
    await expect(
      deployer.deploy({ buildDir: writeBuild(site), gitSha: 'abc1234' }),
    ).rejects.toMatchObject({
      code: ErrorCode.DeployFailed,
      message: expect.stringContaining('site is live'),
    });
  });

  it('refuses sites over the Free plan size', async () => {
    const { deployer } = setup();
    const dir = writeBuild({ 'index.html': 'x' });
    // Rewrite the manifest to claim 300 MB.
    writeFileSync(
      join(dir, '.sforge', 'build-manifest.json'),
      JSON.stringify({
        version: 1,
        files: { 'index.html': { sha256: 'x', size: 300 * 1024 * 1024, cache: 'revalidate' } },
      }),
    );
    await expect(deployer.deploy({ buildDir: dir })).rejects.toMatchObject({
      code: ErrorCode.DeployFailed,
      message: expect.stringContaining('Free plan'),
    });
  });

  it('does not upload when the infrastructure is not provisioned', async () => {
    const { deployer, uploads } = setup({ out: {} });
    await expect(deployer.deploy({ buildDir: writeBuild(site) })).rejects.toMatchObject({
      code: ErrorCode.NotProvisioned,
    });
    expect(uploads).toHaveLength(0);
  });

  it('keeps the upload error but never the token', async () => {
    const failure = new SforgeError(ErrorCode.DeployFailed, 'The deployment client failed');
    const { azure, deployer } = setup({ uploader: { fail: failure } });
    await expect(deployer.deploy({ buildDir: writeBuild(site) })).rejects.toBe(failure);
    expect(azure.history.doc).toBeUndefined();
  });

  it('asks for a sign-in when no credential works', async () => {
    const { azure, deployer, uploads } = setup();
    azure.signIn.error = Object.assign(new Error('Please run az login'), {
      name: 'CredentialUnavailableError',
    });
    await expect(deployer.deploy({ buildDir: writeBuild(site) })).rejects.toMatchObject({
      code: ErrorCode.CloudAuth,
      hint: expect.stringContaining('az login'),
    });
    expect(uploads).toHaveLength(0);
  });
});

describe('Azure versions, rollback and previews', () => {
  async function deployed(n: number, shas = ['aaa1111', 'bbb2222', 'ccc3333']) {
    const ctx = setup();
    for (let i = 0; i < n; i++) {
      await ctx.deployer.deploy({ buildDir: writeBuild(site), gitSha: shas[i]!, now: at(i) });
    }
    return ctx;
  }

  it('lists production versions newest first, then previews', async () => {
    const { deployer } = await deployed(2);
    await deployer.deploy({ buildDir: writeBuild(site), preview: 'pr-7' });
    const versions = await deployer.versions();
    expect(versions.map((v) => [v.id, v.active, v.preview])).toEqual([
      ['20261024T120100Z-bbb2222', true, false],
      ['20261024T120000Z-aaa1111', false, false],
      ['pr7', false, true],
    ]);
    expect(versions[2]!.url).toContain('-pr7.');
  });

  it('rolls back by rebuilding the previous version’s commit', async () => {
    const { azure, uploads } = await deployed(2);
    const built: string[] = [];
    const rollbackDeployer = rollbackWith(azure, uploads, built);
    const result = await rollbackDeployer.rollback();

    expect(built).toEqual(['aaa1111']);
    expect(result.previousVersionId).toBe('20261024T120100Z-bbb2222');
    expect(result.versionId).toMatch(/^\d{8}T\d{6}Z-aaa1111$/);
    const doc = azure.history.doc!;
    expect(doc.active).toBe(result.versionId);
    expect(doc.versions[0]).toMatchObject({
      gitSha: 'aaa1111',
      rollbackOf: '20261024T120000Z-aaa1111',
    });
  });

  it('rolls back to a version chosen by id or by git sha', async () => {
    const { azure, uploads } = await deployed(3);
    const built: string[] = [];
    const d = rollbackWith(azure, uploads, built);
    await d.rollback('20261024T120000Z-aaa1111');
    await d.rollback('bbb2');
    expect(built).toEqual(['aaa1111', 'bbb2222']);
  });

  it('reports an unknown version and an already active one', async () => {
    const { azure, uploads } = await deployed(2);
    const d = rollbackWith(azure, uploads, []);
    await expect(d.rollback('nope')).rejects.toMatchObject({ code: ErrorCode.VersionNotFound });
    await expect(d.rollback('20261024T120100Z-bbb2222')).rejects.toMatchObject({
      code: ErrorCode.Usage,
    });
  });

  it('has nothing to roll back to after a single deploy, or before any', async () => {
    const one = await deployed(1);
    await expect(one.deployer.rollback()).rejects.toMatchObject({
      code: ErrorCode.VersionNotFound,
    });
    const none = setup();
    await expect(none.deployer.rollback()).rejects.toMatchObject({
      code: ErrorCode.VersionNotFound,
    });
  });

  it('cannot rebuild deploys made without a commit or with uncommitted changes', async () => {
    const { azure, uploads } = await deployed(2);
    const doc = azure.history.doc!;
    doc.versions[1]!.dirty = true;
    const d = rollbackWith(azure, uploads, []);
    await expect(d.rollback()).rejects.toMatchObject({
      code: ErrorCode.Unsupported,
      message: expect.stringContaining('uncommitted changes'),
    });
    delete doc.versions[1]!.dirty;
    delete doc.versions[1]!.gitSha;
    await expect(d.rollback()).rejects.toMatchObject({ code: ErrorCode.Unsupported });
  });

  it('removes a preview environment, and reports one that is gone', async () => {
    const { azure, deployer } = setup();
    await deployer.deploy({ buildDir: writeBuild(site), preview: 'pr-9' });
    expect(await deployer.destroyPreview('pr-9')).toMatchObject({ existed: true });
    expect(azure.deletedBuilds).toEqual(['pr9']);
    expect(await deployer.destroyPreview('pr-9')).toMatchObject({ existed: false });
    expect(azure.deletedBuilds).toEqual(['pr9']);
  });

  it('reports the production URL and active version', async () => {
    const { deployer } = await deployed(2);
    expect(await deployer.current()).toEqual({
      url: 'https://lemon-bush-0123456ab.5.azurestaticapps.net',
      versionId: '20261024T120100Z-bbb2222',
    });
  });
});

/** A deployer for the same fake Azure whose rebuild returns a fixed build. */
function rollbackWith(azure: FakeAzure, uploads: unknown[], built: string[]): Deployer {
  const config = azureConfig();
  const { uploader } = fakeUploader(azure);
  return createAzureDeployer(
    {
      rootDir: mkdtempSync(join(tmpdir(), 'sforge-azure-root-')),
      config,
      targetName: 'prod',
      target: config.targets.prod!,
      outputs,
      env: { AZURE_SUBSCRIPTION_ID: '07be2078-a22e-42b2-a654-91c56c8ebcdd' },
      logger,
    },
    azure.clients,
    {
      uploader: async (request) => {
        uploads.push(request);
        return uploader(request);
      },
      rebuild: async (sha) => {
        built.push(sha);
        return { buildDir: writeBuild(site), cleanup: () => {} };
      },
      pollIntervalMs: 1,
    },
  );
}
