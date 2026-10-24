import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Logger, type SforgeConfig, createLogger, validateConfig } from '@staticforge/core';
import {
  type IacProfile,
  type IacSpec,
  type StateBackend,
  compareVersions,
  destroy,
  detectDrift,
  downloadTofu,
  projectName,
  provision,
  readCachedOutputs,
  resolveEngine,
  writeWorkspace,
} from '../src/index.js';
import { extractFromTarGz } from '../src/tar.js';
import { applyCreates, fakeEngine, planCreates } from './fake-engine.js';

const logger: Logger = createLogger({ level: 'silent' });

function project(): { rootDir: string; config: SforgeConfig } {
  const rootDir = mkdtempSync(join(tmpdir(), 'sforge-iac-'));
  const config = validateConfig({
    site: { title: 'Site', baseUrl: 'https://www.example.com' },
    targets: { staging: { provider: 'aws', region: 'eu-central-1' } },
  });
  return { rootDir, config };
}

function moduleDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sforge-module-'));
  writeFileSync(join(dir, 'main.tf'), 'variable "name" {}\n');
  mkdirSync(join(dir, 'tests'));
  writeFileSync(join(dir, 'tests', 'x.tftest.hcl'), '');
  return dir;
}

function spec(dir: string, backend: IacSpec['backend']): IacSpec {
  return {
    requiredProviders: { aws: { source: 'hashicorp/aws', version: '~> 6.0' } },
    providers: { aws: [{ region: 'eu-central-1' }, { alias: 'us_east_1', region: 'us-east-1' }] },
    module: {
      name: 'site',
      dir,
      inputs: { name: 'www-example-com', retain_versions: 10 },
      providers: { 'aws.us_east_1': 'aws.us_east_1' },
    },
    outputs: ['bucket', 'distribution_id'],
    backend,
    env: { AWS_REGION: 'eu-central-1' },
  };
}

const s3 = { type: 's3' as const, config: { bucket: 'state', key: 'k', use_lockfile: true } };

function profile(state: Partial<StateBackend> = {}, module = moduleDir()): IacProfile {
  return {
    provider: 'aws',
    async prepare() {
      return {
        spec: spec(module, s3),
        state: {
          id: 'aws-123-eu-central-1',
          description: 's3://state',
          exists: true,
          bootstrap: spec(module, { type: 's3', config: { bucket: 'state', key: '_bootstrap' } }),
          ...state,
        },
        preDestroyInputs: { force_destroy: true },
      };
    },
  };
}

const outputsStep = {
  stdout: [
    JSON.stringify({
      bucket: { value: 'site-bucket', sensitive: false, type: 'string' },
      distribution_id: { value: 'E123', sensitive: false, type: 'string' },
      secret: { value: 'x', sensitive: true, type: 'string' },
    }),
  ],
};

describe('versions and names', () => {
  it('compares versions numerically', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('v1.13.1', '1.13.1')).toBe(0);
    expect(compareVersions('1.13.0-rc1', '1.13.0')).toBe(0);
    expect(compareVersions('1.2', '1.2.1')).toBe(-1);
  });

  it('derives a resource-safe project name from the site URL', () => {
    const { config } = project();
    expect(projectName(config)).toBe('www-example-com');
    expect(
      projectName({ ...config, site: { ...config.site, baseUrl: 'https://1.example.com' } }),
    ).toBe('s-1-example-com');
    expect(projectName({ ...config, iac: { ...config.iac, name: 'docs' } })).toBe('docs');
  });
});

describe('engine resolution', () => {
  it('uses a supported binary from PATH and ignores old ones', async () => {
    const fake = fakeEngine();
    const dir = join(fake.engine.path, '..');
    const found = await resolveEngine({ engine: 'tofu', env: { PATH: dir }, logger });
    expect(found).toMatchObject({
      name: 'tofu',
      path: fake.engine.path,
      version: '1.13.1',
      source: 'path',
    });

    await expect(
      resolveEngine({ engine: 'terraform', env: { PATH: dir }, logger }),
    ).rejects.toMatchObject({ code: 'SF_ENGINE_MISSING' });
  });

  it('requires the exact iac.version and falls back to the cached download', async () => {
    const fake = fakeEngine();
    const cache = mkdtempSync(join(tmpdir(), 'sforge-cache-'));
    const cached = join(cache, 'bin', 'tofu-1.12.0', 'tofu');
    mkdirSync(join(cached, '..'), { recursive: true });
    writeFileSync(cached, '#!/bin/sh\n');
    chmodSync(cached, 0o755);
    const found = await resolveEngine({
      engine: 'tofu',
      version: '1.12.0',
      env: { PATH: join(fake.engine.path, '..'), SFORGE_CACHE_DIR: cache },
      logger,
    });
    expect(found).toMatchObject({ path: cached, version: '1.12.0', source: 'cache' });
  });

  it('honours SFORGE_TERRAFORM_PATH and rejects unsupported versions', async () => {
    const fake = fakeEngine();
    const found = await resolveEngine({
      engine: 'terraform',
      env: { SFORGE_TERRAFORM_PATH: fake.engine.path },
      logger,
    });
    expect(found).toMatchObject({ name: 'terraform', source: 'env' });
    process.env.FAKE_ENGINE_VERSION = '1.9.0';
    try {
      await expect(
        resolveEngine({
          engine: 'terraform',
          env: { SFORGE_TERRAFORM_PATH: fake.engine.path },
          logger,
        }),
      ).rejects.toMatchObject({ code: 'SF_ENGINE_MISSING' });
    } finally {
      delete process.env.FAKE_ENGINE_VERSION;
    }
  });
});

describe('OpenTofu download', () => {
  function archive(): Buffer {
    const dir = mkdtempSync(join(tmpdir(), 'sforge-tar-'));
    writeFileSync(join(dir, 'tofu'), '#!/bin/sh\necho tofu\n');
    writeFileSync(join(dir, 'README.md'), 'readme');
    const out = join(dir, 'tofu.tar.gz');
    execFileSync('tar', ['-czf', out, '-C', dir, 'README.md', 'tofu']);
    return readFileSync(out);
  }

  it('extracts one file from a tar.gz', () => {
    expect(extractFromTarGz(archive(), 'tofu')?.toString()).toContain('echo tofu');
    expect(extractFromTarGz(archive(), 'missing')).toBeUndefined();
  });

  it('verifies the checksum from SHA256SUMS and installs the binary', async () => {
    const tarball = archive();
    const sha = createHash('sha256').update(tarball).digest('hex');
    const urls: string[] = [];
    const fetch = async (url: string) => {
      urls.push(url);
      if (url.endsWith('SHA256SUMS')) {
        return new Response(`${sha}  tofu_1.11.0_linux_amd64.tar.gz\nabc  other.zip\n`);
      }
      return new Response(tarball);
    };
    const installDir = mkdtempSync(join(tmpdir(), 'sforge-install-'));
    const path = await downloadTofu({
      version: '1.11.0',
      installDir,
      logger,
      fetch,
      platform: 'linux',
      arch: 'x64',
    });
    expect(path).toBe(join(installDir, 'tofu'));
    expect(readFileSync(path, 'utf8')).toContain('echo tofu');
    expect(urls).toContain(
      'https://github.com/opentofu/opentofu/releases/download/v1.11.0/tofu_1.11.0_linux_amd64.tar.gz',
    );
  });

  it('rejects a download whose checksum does not match', async () => {
    const tarball = archive();
    const fetch = async (url: string) =>
      new Response(
        url.endsWith('SHA256SUMS')
          ? `${'0'.repeat(64)}  tofu_1.11.0_linux_amd64.tar.gz\n`
          : tarball,
      );
    const installDir = mkdtempSync(join(tmpdir(), 'sforge-install-'));
    await expect(
      downloadTofu({
        version: '1.11.0',
        installDir,
        logger,
        fetch,
        platform: 'linux',
        arch: 'x64',
      }),
    ).rejects.toMatchObject({
      code: 'SF_ENGINE_MISSING',
      message: expect.stringContaining('Checksum'),
    });
    expect(existsSync(join(installDir, 'tofu'))).toBe(false);
  });

  it('uses the embedded checksums for the pinned version', async () => {
    const urls: string[] = [];
    const fetch = async (url: string) => {
      urls.push(url);
      return new Response(archive());
    };
    const installDir = mkdtempSync(join(tmpdir(), 'sforge-install-'));
    await expect(
      downloadTofu({
        version: '1.13.1',
        installDir,
        logger,
        fetch,
        platform: 'linux',
        arch: 'x64',
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('Checksum mismatch') });
    expect(urls.some((url) => url.endsWith('SHA256SUMS'))).toBe(false);
  });
});

describe('workspace generation', () => {
  it('writes the root module, backend, tfvars and gitignore', () => {
    const module = moduleDir();
    const dir = mkdtempSync(join(tmpdir(), 'sforge-ws-'));
    const extra = mkdtempSync(join(tmpdir(), 'sforge-infra-'));
    writeFileSync(join(extra, 'waf.tf'), 'resource "x" "y" {}\n');
    writeFileSync(join(extra, 'notes.md'), 'ignored');
    const files = writeWorkspace({ dir, spec: spec(module, s3), extraDir: extra });
    expect(files).toEqual([
      'main.tf.json',
      'backend.tf.json',
      'terraform.tfvars.json',
      '.gitignore',
      'infra_waf.tf',
    ]);

    const main = JSON.parse(readFileSync(join(dir, 'main.tf.json'), 'utf8'));
    expect(main.terraform.required_version).toBe('>= 1.10.0');
    expect(main.provider.aws).toHaveLength(2);
    expect(main.variable).toEqual({ name: {}, retain_versions: {} });
    expect(main.module.site).toMatchObject({
      providers: { 'aws.us_east_1': 'aws.us_east_1' },
      name: '${var.name}',
      retain_versions: '${var.retain_versions}',
    });
    expect(main.module.site.source).toMatch(/^\.\.\//);
    expect(main.output.bucket).toEqual({ value: '${module.site.bucket}' });
    expect(
      JSON.parse(readFileSync(join(dir, 'backend.tf.json'), 'utf8')).terraform.backend.s3,
    ).toEqual(s3.config);
    expect(JSON.parse(readFileSync(join(dir, 'terraform.tfvars.json'), 'utf8'))).toEqual({
      name: 'www-example-com',
      retain_versions: 10,
    });
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toContain('/main.tf.json');

    // Removing an infra file removes its copy; switching to local state removes the backend.
    writeFileSync(join(extra, 'waf.tf'), '');
    execFileSync('rm', [join(extra, 'waf.tf')]);
    writeWorkspace({ dir, spec: spec(module, { type: 'local', config: {} }), extraDir: extra });
    expect(existsSync(join(dir, 'infra_waf.tf'))).toBe(false);
    expect(existsSync(join(dir, 'backend.tf.json'))).toBe(false);
  });

  it('vendors the module without its tests', () => {
    const module = moduleDir();
    const dir = mkdtempSync(join(tmpdir(), 'sforge-ws-'));
    writeWorkspace({ dir, spec: spec(module, s3), vendor: true });
    const main = JSON.parse(readFileSync(join(dir, 'main.tf.json'), 'utf8'));
    expect(main.module.site.source).toBe('./modules/site');
    expect(existsSync(join(dir, 'modules', 'site', 'main.tf'))).toBe(true);
    expect(existsSync(join(dir, 'modules', 'site', 'tests'))).toBe(false);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).not.toContain('main.tf.json');
  });
});

describe('provision', () => {
  it('plans without applying for --diff', async () => {
    const { rootDir, config } = project();
    const fake = fakeEngine({
      init: { files: { '.terraform.lock.hcl': '# lock' } },
      plan: planCreates('module.site.aws_s3_bucket.site'),
    });
    const result = await provision({
      rootDir,
      config,
      targetName: 'staging',
      profile: profile(),
      logger,
      engine: fake.engine,
      env: {},
      diff: true,
    });
    expect(result.applied).toBe(false);
    expect(result.plan).toMatchObject({
      changes: true,
      add: 1,
      resources: [{ address: 'module.site.aws_s3_bucket.site', action: 'create' }],
    });
    const commands = fake.calls().map((c) => c.args[0]);
    expect(commands).toEqual(['init', 'providers', 'plan']);
    const [init, lock, plan] = fake.calls();
    expect(init!.cwd).toBe(join(rootDir, '.sforge', 'iac', 'staging'));
    expect(init!.env).toMatchObject({ TF_IN_AUTOMATION: '1', AWS_REGION: 'eu-central-1' });
    expect(lock!.args).toContain('-platform=linux_amd64');
    expect(plan!.args).toEqual([
      'plan',
      '-input=false',
      '-json',
      '-detailed-exitcode',
      '-out=tfplan',
    ]);
  });

  it('applies after confirmation and caches the public outputs', async () => {
    const { rootDir, config } = project();
    const fake = fakeEngine({
      plan: planCreates('module.site.aws_s3_bucket.site'),
      apply: applyCreates('module.site.aws_s3_bucket.site'),
      output: outputsStep,
    });
    const questions: string[] = [];
    const result = await provision({
      rootDir,
      config,
      targetName: 'staging',
      profile: profile(),
      logger,
      engine: fake.engine,
      env: {},
      confirm: async (question) => {
        questions.push(question);
        return true;
      },
    });
    expect(questions).toEqual(['Apply these changes to "staging"?']);
    expect(result).toMatchObject({
      applied: true,
      apply: { add: 1 },
      outputs: { bucket: 'site-bucket' },
    });
    expect(result.outputs).not.toHaveProperty('secret');
    expect(readCachedOutputs(rootDir, 'staging')).toMatchObject({
      target: 'staging',
      provider: 'aws',
      engine: 'tofu',
      outputs: { bucket: 'site-bucket', distribution_id: 'E123' },
    });
    expect(fake.calls().find((c) => c.args[0] === 'apply')!.args).toEqual([
      'apply',
      '-input=false',
      '-json',
      'tfplan',
    ]);
  });

  it('does not apply when declined or when nothing changed', async () => {
    const { rootDir, config } = project();
    const fake = fakeEngine({ plan: planCreates('a.b'), output: outputsStep });
    await expect(
      provision({
        rootDir,
        config,
        targetName: 'staging',
        profile: profile(),
        logger,
        engine: fake.engine,
        env: {},
        confirm: async () => false,
      }),
    ).rejects.toMatchObject({ code: 'SF_ABORTED' });
    expect(fake.calls().some((c) => c.args[0] === 'apply')).toBe(false);

    fake.script({ plan: planCreates(), output: outputsStep });
    const unchanged = await provision({
      rootDir,
      config,
      targetName: 'staging',
      profile: profile(),
      logger,
      engine: fake.engine,
      env: {},
    });
    expect(unchanged).toMatchObject({
      applied: false,
      plan: { changes: false },
      outputs: { bucket: 'site-bucket' },
    });
  });

  it('refuses to run without a state backend unless asked to create one', async () => {
    const { rootDir, config } = project();
    const fake = fakeEngine();
    await expect(
      provision({
        rootDir,
        config,
        targetName: 'staging',
        profile: profile({ exists: false }),
        logger,
        engine: fake.engine,
        env: {},
      }),
    ).rejects.toMatchObject({
      code: 'SF_STATE_MISSING',
      hint: expect.stringContaining('--bootstrap-state'),
    });
    expect(fake.calls()).toEqual([]);
  });

  it('bootstraps the backend with local state, then migrates it', async () => {
    const { rootDir, config } = project();
    const stateFile = JSON.stringify({ resources: [{ type: 'aws_s3_bucket' }] });
    const fake = fakeEngine({
      init: [{}, {}, {}],
      plan: [planCreates('aws_s3_bucket.state'), planCreates()],
      apply: { ...applyCreates('aws_s3_bucket.state'), files: { 'terraform.tfstate': stateFile } },
      output: outputsStep,
    });
    const result = await provision({
      rootDir,
      config,
      targetName: 'staging',
      profile: profile({ exists: false }),
      logger,
      engine: fake.engine,
      env: {},
      bootstrapState: true,
    });
    expect(result.bootstrap).toEqual({
      backend: 'aws-123-eu-central-1',
      description: 's3://state',
      created: true,
    });
    const bootstrapDir = join(rootDir, '.sforge', 'iac', '_state', 'aws-123-eu-central-1');
    const calls = fake
      .calls()
      .map((c) => [
        c.args[0],
        c.cwd === bootstrapDir ? 'bootstrap' : 'target',
        c.args.includes('-migrate-state'),
      ]);
    expect(calls).toEqual([
      ['init', 'bootstrap', false],
      ['plan', 'bootstrap', false],
      ['apply', 'bootstrap', false],
      ['init', 'bootstrap', true],
      ['init', 'target', false],
      ['plan', 'target', false],
      ['output', 'target', false],
    ]);
    expect(existsSync(join(bootstrapDir, 'terraform.tfstate'))).toBe(false);
    expect(existsSync(join(bootstrapDir, 'backend.tf.json'))).toBe(true);
  });

  it('skips the bootstrap when the backend exists', async () => {
    const { rootDir, config } = project();
    const fake = fakeEngine({ plan: planCreates(), output: outputsStep });
    const result = await provision({
      rootDir,
      config,
      targetName: 'staging',
      profile: profile(),
      logger,
      engine: fake.engine,
      env: {},
      bootstrapState: true,
    });
    expect(result.bootstrap).toMatchObject({ created: false });
    expect(fake.calls().every((c) => !c.cwd.includes('_state'))).toBe(true);
  });

  it('keeps state in the workspace with localState', async () => {
    const { rootDir, config } = project();
    const fake = fakeEngine({ plan: planCreates(), output: outputsStep });
    await provision({
      rootDir,
      config,
      targetName: 'staging',
      profile: profile({ exists: false }),
      logger,
      engine: fake.engine,
      env: {},
      localState: true,
    });
    expect(existsSync(join(rootDir, '.sforge', 'iac', 'staging', 'backend.tf.json'))).toBe(false);
  });

  it('reports engine diagnostics and credential errors with stable codes', async () => {
    const { rootDir, config } = project();
    const diagnostic = (summary: string) => ({
      exitCode: 1,
      stdout: [
        {
          '@level': 'error',
          '@message': `Error: ${summary}`,
          type: 'diagnostic',
          diagnostic: { severity: 'error', summary, detail: 'more', address: 'module.site.x' },
        },
      ],
    });
    const fake = fakeEngine({ plan: diagnostic('Invalid value for variable') });
    const run = () =>
      provision({
        rootDir,
        config,
        targetName: 'staging',
        profile: profile(),
        logger,
        engine: fake.engine,
        env: {},
      });
    await expect(run()).rejects.toMatchObject({
      code: 'SF_IAC_FAILED',
      message: 'tofu plan failed: Invalid value for variable (module.site.x)',
      details: {
        diagnostics: [expect.objectContaining({ summary: 'Invalid value for variable' })],
      },
    });

    fake.script({ plan: diagnostic('No valid credential sources found') });
    await expect(run()).rejects.toMatchObject({ code: 'SF_CLOUD_AUTH' });

    fake.script({
      init: {
        exitCode: 1,
        stderr:
          '\nError: Failed to query available provider packages\n\nCould not retrieve the list\n',
      },
    });
    await expect(run()).rejects.toMatchObject({
      code: 'SF_IAC_FAILED',
      message: 'tofu init failed: Failed to query available provider packages',
    });
  });
});

describe('drift and destroy', () => {
  it('reports drift from a refresh-only plan', async () => {
    const { rootDir, config } = project();
    const fake = fakeEngine({
      plan: {
        exitCode: 2,
        stdout: [
          {
            '@level': 'info',
            '@message': 'module.site.aws_s3_bucket.site: Drift detected (update)',
            type: 'resource_drift',
            change: { resource: { addr: 'module.site.aws_s3_bucket.site' }, action: 'update' },
          },
        ],
      },
      output: outputsStep,
    });
    const result = await detectDrift({
      rootDir,
      config,
      targetName: 'staging',
      profile: profile(),
      logger,
      engine: fake.engine,
      env: {},
    });
    expect(result).toMatchObject({
      drifted: true,
      drift: [{ address: 'module.site.aws_s3_bucket.site', action: 'update' }],
      outputs: { bucket: 'site-bucket' },
    });
    expect(fake.calls().find((c) => c.args[0] === 'plan')!.args).toContain('-refresh-only');
  });

  it('applies the pre-destroy inputs before destroying', async () => {
    const { rootDir, config } = project();
    const fake = fakeEngine({
      plan: [planCreates('a.b'), planCreates('a.b'), planCreates('a.b')],
      apply: [applyCreates(), applyCreates()],
    });
    const result = await destroy({
      rootDir,
      config,
      targetName: 'staging',
      profile: profile(),
      logger,
      engine: fake.engine,
      env: {},
    });
    expect(result.destroyed).toBe(true);
    const plans = fake.calls().filter((c) => c.args[0] === 'plan');
    expect(plans.map((c) => c.args.includes('-destroy'))).toEqual([true, false, true]);
    expect(fake.calls().filter((c) => c.args[0] === 'apply')).toHaveLength(2);
    const tfvars = JSON.parse(
      readFileSync(join(rootDir, '.sforge', 'iac', 'staging', 'terraform.tfvars.json'), 'utf8'),
    );
    expect(tfvars.force_destroy).toBe(true);
  });
});
