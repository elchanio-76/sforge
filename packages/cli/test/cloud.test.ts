import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { type DnsProfile, type IacProfile, prepareDns } from '@staticforge/iac';
import type { DeployOptions, Deployer, Provider } from '@staticforge/provider-api';
import { applyCreates, fakeEngine, planCreates } from '../../providers/iac/test/fake-engine.js';
import type { Io } from '../src/io.js';
import { run } from '../src/main.js';
import { expectValidEnvelope } from './schema-validation.js';

function sink() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(String(chunk));
      done();
    },
  });
  return { stream, text: () => chunks.join('') };
}

interface Options {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Answers to prompts; a TTY is simulated when given. */
  answers?: string[];
  providers?: Partial<Record<'aws' | 'azure', Provider>>;
  dns?: Partial<Record<'cloudflare', DnsProfile>>;
}

async function sforge(args: string[], options: Options) {
  const stdout = sink();
  const stderr = sink();
  const answers = [...(options.answers ?? [])];
  const prompts: string[] = [];
  const io: Io = {
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdinIsTTY: options.answers !== undefined,
    env: options.env ?? {},
    cwd: options.cwd,
    onShutdown: () => () => {},
    async prompt(question) {
      prompts.push(question);
      return answers.shift() ?? '';
    },
  };
  const exitCode = await run(['node', 'sforge', ...args], io, {
    ...(options.providers && { providers: options.providers }),
    ...(options.dns && { dns: options.dns }),
  });
  const out = stdout.text();
  // Every --json document must match `sforge schema output`.
  if (args.includes('--json') && out.trim() !== '') expectValidEnvelope(JSON.parse(out));
  return {
    exitCode,
    stdout: out,
    stderr: stderr.text(),
    prompts,
    json: () => JSON.parse(out),
  };
}

function project(
  targets: Record<string, unknown> = { staging: { provider: 'aws', region: 'eu-central-1' } },
) {
  const dir = mkdtempSync(join(tmpdir(), 'sforge-cloud-'));
  writeFileSync(
    join(dir, 'staticforge.config.json'),
    JSON.stringify({ site: { title: 'Site', baseUrl: 'https://www.example.com' }, targets }),
  );
  mkdirSync(join(dir, 'content'));
  writeFileSync(join(dir, 'content', 'index.md'), '---\ntitle: Home\n---\n\nWelcome.\n');
  return dir;
}

const outputs = {
  bucket: { value: 'site-bucket', sensitive: false },
  url: { value: 'https://d111.cloudfront.net', sensitive: false },
};

function fakeProvider(options: { stateExists?: boolean } = {}) {
  const deploys: DeployOptions[] = [];
  const rollbacks: (string | undefined)[] = [];
  const module = mkdtempSync(join(tmpdir(), 'sforge-module-'));
  const iac: IacProfile = {
    provider: 'aws',
    async prepare() {
      const spec = {
        requiredProviders: {},
        providers: {},
        module: { name: 'site', dir: module, inputs: { name: 'x' } },
        outputs: ['bucket', 'url', 'dns_records'],
        backend: { type: 's3' as const, config: { bucket: 'state', key: 'k' } },
      };
      return {
        spec,
        state: {
          id: 'aws-1-r',
          description: 's3://state/k',
          exists: options.stateExists ?? true,
          bootstrap: spec,
        },
      };
    },
  };
  const deployer: Deployer = {
    async deploy(o) {
      deploys.push(o);
      return {
        target: 'staging',
        provider: 'aws',
        versionId: o.preview ?? 'v2',
        url: 'https://d111.cloudfront.net',
        preview: o.preview !== undefined,
        uploaded: 3,
        copied: 1,
        skipped: 0,
        deleted: 0,
        bytes: 2048,
        pruned: [],
        invalidated: false,
        dryRun: o.dryRun === true,
      };
    },
    async versions() {
      return [
        {
          id: 'v2',
          createdAt: '2026-10-24T12:00:00Z',
          files: 4,
          bytes: 2048,
          active: true,
          preview: false,
        },
        {
          id: 'v1',
          createdAt: '2026-10-24T11:00:00Z',
          files: 4,
          bytes: 2048,
          active: false,
          preview: false,
        },
      ];
    },
    async rollback(to) {
      rollbacks.push(to);
      return {
        target: 'staging',
        versionId: to ?? 'v1',
        previousVersionId: 'v2',
        url: 'https://d111.cloudfront.net',
      };
    },
    async destroyPreview(id) {
      return { target: 'staging', previewId: id, deleted: 3, existed: true };
    },
    async current() {
      return { url: 'https://d111.cloudfront.net', versionId: 'v2' };
    },
  };
  const provider: Provider = {
    id: 'aws',
    iac,
    createDeployer: () => deployer,
    requiredOutputs: [],
  };
  return { provider, deploys, rollbacks };
}

function engineEnv(script: Parameters<typeof fakeEngine>[0]) {
  const fake = fakeEngine(script);
  return { fake, env: { SFORGE_TOFU_PATH: fake.engine.path } };
}

describe('sforge provision', () => {
  it('shows the plan with --diff and changes nothing', async () => {
    const cwd = project();
    const { fake, env } = engineEnv({ plan: planCreates('module.site.aws_s3_bucket.site') });
    const result = await sforge(['provision', 'staging', '--diff', '--json'], {
      cwd,
      env,
      providers: { aws: fakeProvider().provider },
    });
    expect(result.exitCode).toBe(0);
    expect(result.json()).toMatchObject({
      command: 'provision',
      ok: true,
      data: {
        target: 'staging',
        applied: false,
        plan: { changes: true, add: 1, resources: [{ address: 'module.site.aws_s3_bucket.site' }] },
      },
    });
    expect(fake.calls().map((c) => c.args[0])).not.toContain('apply');
  });

  it('asks before applying, and requires --yes when it cannot ask', async () => {
    const cwd = project();
    const script = {
      plan: planCreates('module.site.aws_s3_bucket.site'),
      apply: applyCreates('module.site.aws_s3_bucket.site'),
      output: { stdout: [JSON.stringify(outputs)] },
    };
    const { fake, env } = engineEnv(script);
    const providers = { aws: fakeProvider().provider };

    const ci = await sforge(['provision', 'staging', '--json'], {
      cwd,
      env: { ...env, CI: 'true' },
      providers,
    });
    expect(ci.exitCode).toBe(2);
    expect(ci.json().error).toMatchObject({
      code: 'SF_CONFIRMATION_REQUIRED',
      hint: expect.stringContaining('--yes'),
    });

    const declined = await sforge(['provision', 'staging'], {
      cwd,
      env,
      providers,
      answers: ['no'],
    });
    expect(declined.exitCode).toBe(1);
    expect(declined.prompts).toEqual([
      'Apply these changes to "staging"? Type "yes" to continue: ',
    ]);
    expect(declined.stderr).toContain('+ module.site.aws_s3_bucket.site (create)');

    const accepted = await sforge(['provision', 'staging'], {
      cwd,
      env,
      providers,
      answers: ['yes'],
    });
    expect(accepted.exitCode).toBe(0);
    expect(accepted.stdout).toContain('URL: https://d111.cloudfront.net');
    expect(existsSync(join(cwd, '.sforge', 'state', 'staging.json'))).toBe(true);

    fake.script(script);
    const yes = await sforge(['provision', 'staging', '--yes', '--json'], {
      cwd,
      env: { ...env, CI: 'true' },
      providers,
    });
    expect(yes.json()).toMatchObject({
      ok: true,
      data: { applied: true, outputs: { bucket: 'site-bucket' } },
    });
  });

  it('lists the DNS records to create unless sforge manages the zone', async () => {
    const records = [{ name: 'www.example.com', type: 'CNAME', value: 'd111.cloudfront.net' }];
    const script = {
      plan: planCreates('module.site.aws_s3_bucket.site'),
      apply: applyCreates('module.site.aws_s3_bucket.site'),
      output: {
        stdout: [JSON.stringify({ ...outputs, dns_records: { value: records, sensitive: false } })],
      },
    };
    const provision = async (target: Record<string, unknown>) => {
      const { env } = engineEnv(script);
      const cwd = project({ staging: { provider: 'aws', region: 'eu-central-1', ...target } });
      const providers = { aws: fakeProvider().provider };
      return sforge(['provision', 'staging', '--yes'], { cwd, env, providers });
    };
    const manual = await provision({ domain: 'www.example.com' });
    expect(manual.stdout).toContain(
      'Create these DNS records for the site:\n  www.example.com CNAME d111.cloudfront.net',
    );
    const route53 = await provision({ domain: 'www.example.com', hostedZone: 'example.com' });
    expect(route53.exitCode).toBe(0);
    expect(route53.stdout).not.toContain('DNS records');
  });

  it('explains a missing state backend', async () => {
    const cwd = project();
    const { env } = engineEnv({});
    const result = await sforge(['provision', 'staging', '--diff', '--json'], {
      cwd,
      env,
      providers: { aws: fakeProvider({ stateExists: false }).provider },
    });
    expect(result.exitCode).toBe(2);
    expect(result.json().error).toMatchObject({
      code: 'SF_STATE_MISSING',
      hint: expect.stringContaining('sforge provision staging --bootstrap-state'),
    });
  });

  it('refuses --local-state in CI unless forced', async () => {
    const cwd = project();
    const { env } = engineEnv({ plan: planCreates() });
    const providers = { aws: fakeProvider().provider };
    const refused = await sforge(['provision', 'staging', '--diff', '--local-state', '--json'], {
      cwd,
      env: { ...env, CI: 'true' },
      providers,
    });
    expect(refused.json().error.code).toBe('SF_USAGE');
    const forced = await sforge(
      ['provision', 'staging', '--diff', '--local-state', '--force-local-state', '--json'],
      {
        cwd,
        env: { ...env, CI: 'true' },
        providers,
      },
    );
    expect(forced.exitCode).toBe(0);
  });

  it('reports unknown targets', async () => {
    const cwd = project();
    const unknown = await sforge(['provision', 'nope', '--json'], { cwd });
    expect(unknown.json().error.code).toBe('SF_TARGET_NOT_FOUND');
  });

  it('tells Azure targets that apex domains are not supported yet', async () => {
    // Rejected before any Azure call is made.
    const cwd = project({
      prod: {
        provider: 'azure',
        resourceGroup: 'rg',
        location: 'westeurope',
        domain: 'example.com',
      },
    });
    const result = await sforge(['provision', 'prod', '--json'], { cwd });
    expect(result.exitCode).toBe(2);
    expect(result.json().error).toMatchObject({
      code: 'SF_UNSUPPORTED',
      hint: 'Use a subdomain such as www.example.com.',
    });
  });
});

describe('targets with dns', () => {
  const targets = {
    staging: {
      provider: 'aws',
      region: 'eu-central-1',
      domain: 'www.example.com',
      dns: { provider: 'cloudflare', zone: 'example.com' },
    },
  };

  /** A provider whose profile prepares the target's DNS like the real ones. */
  function dnsAwareProvider() {
    const { provider } = fakeProvider();
    const prepare = provider.iac.prepare.bind(provider.iac);
    const zones: string[] = [];
    provider.iac = {
      provider: 'aws',
      async prepare(input) {
        const dns = await prepareDns(input, ['www.example.com']);
        if (dns !== undefined) zones.push(String(dns.records('r', { ref: 'x' }).inputs.zone_id));
        return prepare(input);
      },
    };
    return { provider, zones };
  }

  it('loads the DNS provider and hands it to the profile', async () => {
    const cwd = project(targets);
    const { env } = engineEnv({ plan: planCreates('module.site.aws_s3_bucket.site') });
    const { provider, zones } = dnsAwareProvider();
    const dns: DnsProfile = {
      provider: 'cloudflare',
      async prepare() {
        return {
          requiredProviders: {},
          providers: {},
          records: (name, records) => ({ name, dir: '/r', inputs: { zone_id: 'zone-1', records } }),
        };
      },
    };
    const result = await sforge(['provision', 'staging', '--diff', '--json'], {
      cwd,
      env,
      providers: { aws: provider },
      dns: { cloudflare: dns },
    });
    expect(result.exitCode).toBe(0);
    expect(zones).toEqual(['zone-1']);
  });

  it('asks for the Cloudflare API token before planning', async () => {
    const cwd = project(targets);
    const { fake, env } = engineEnv({});
    const result = await sforge(['provision', 'staging', '--diff', '--json'], {
      cwd,
      env,
      providers: { aws: dnsAwareProvider().provider },
    });
    expect(result.exitCode).toBe(2);
    expect(result.json().error).toMatchObject({
      code: 'SF_CLOUD_AUTH',
      message: 'CLOUDFLARE_API_TOKEN is not set',
      hint: expect.stringContaining('Edit zone DNS'),
    });
    expect(fake.calls().map((c) => c.args[0])).not.toContain('plan');
  });
});

describe('sforge status, iac and destroy', () => {
  it('exits 1 when the infrastructure drifted', async () => {
    const cwd = project();
    const drift = {
      exitCode: 2,
      stdout: [
        {
          '@level': 'info',
          '@message': 'drift',
          type: 'resource_drift',
          change: { resource: { addr: 'module.site.aws_s3_bucket.site' }, action: 'update' },
        },
      ],
    };
    const { env } = engineEnv({ plan: drift, output: { stdout: [JSON.stringify(outputs)] } });
    const result = await sforge(['status', 'staging', '--json'], {
      cwd,
      env,
      providers: { aws: fakeProvider().provider },
    });
    expect(result.exitCode).toBe(1);
    expect(result.json()).toMatchObject({
      ok: false,
      data: { drifted: true, url: 'https://d111.cloudfront.net', versionId: 'v2' },
    });
  });

  it('prints the workspace path and passes engine output to stderr under --json', async () => {
    const cwd = project();
    const { fake, env } = engineEnv({
      validate: { stdout: ['Success! The configuration is valid.'] },
    });
    const providers = { aws: fakeProvider().provider };
    const path = await sforge(['iac', 'path', 'staging'], { cwd, env, providers });
    expect(path.stdout.trim()).toBe(join(cwd, '.sforge', 'iac', 'staging'));
    expect(existsSync(join(cwd, '.sforge', 'iac', 'staging', 'main.tf.json'))).toBe(true);

    const validate = await sforge(['iac', 'validate', 'staging', '--json', '--', '-no-color'], {
      cwd,
      env,
      providers,
    });
    expect(validate.exitCode).toBe(0);
    expect(validate.stderr).toContain('Success!');
    expect(validate.json().data).toMatchObject({ command: 'validate', exitCode: 0 });
    expect(fake.calls().at(-1)!.args).toEqual(['validate', '-no-color']);
  });

  it('requires --confirm with the target name to destroy', async () => {
    const cwd = project();
    const result = await sforge(['destroy', 'staging', '--confirm', 'prod', '--json'], {
      cwd,
      providers: { aws: fakeProvider().provider },
    });
    expect(result.json().error.code).toBe('SF_CONFIRMATION_REQUIRED');
  });
});

describe('sforge deploy, versions and rollback', () => {
  function provisioned() {
    const cwd = project();
    mkdirSync(join(cwd, '.sforge', 'state'), { recursive: true });
    writeFileSync(
      join(cwd, '.sforge', 'state', 'staging.json'),
      JSON.stringify({
        target: 'staging',
        provider: 'aws',
        engine: 'tofu',
        updatedAt: '',
        outputs: { url: 'https://d111.cloudfront.net' },
      }),
    );
    return cwd;
  }

  it('builds, checks and deploys', async () => {
    const cwd = provisioned();
    const fake = fakeProvider();
    const result = await sforge(['deploy', 'staging', '--no-headless', '--json'], {
      cwd,
      providers: { aws: fake.provider },
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.json().data).toMatchObject({
      versionId: 'v2',
      uploaded: 3,
      check: { summary: { error: 0 } },
    });
    expect(fake.deploys[0]!.buildDir).toBe(join(cwd, 'dist'));
    expect(existsSync(join(cwd, 'dist', 'index.html'))).toBe(true);
  });

  it('refuses to deploy a site that fails the check', async () => {
    const cwd = provisioned();
    writeFileSync(
      join(cwd, 'content', 'index.md'),
      '---\ntitle: Home\n---\n\n![](missing-alt.png)\n',
    );
    const fake = fakeProvider();
    const result = await sforge(['deploy', 'staging', '--no-headless', '--json'], {
      cwd,
      providers: { aws: fake.provider },
    });
    expect(result.exitCode).toBe(1);
    expect(result.json().error).toMatchObject({
      code: 'SF_CHECK_FAILED',
      hint: expect.stringContaining('--no-check'),
    });
    expect(fake.deploys).toHaveLength(0);

    const forced = await sforge(['deploy', 'staging', '--no-check', '--json'], {
      cwd,
      providers: { aws: fake.provider },
    });
    expect(forced.exitCode).toBe(0);
  });

  it('lists versions and rolls back after confirmation', async () => {
    const cwd = provisioned();
    const fake = fakeProvider();
    const providers = { aws: fake.provider };
    const versions = await sforge(['versions', 'staging'], { cwd, providers });
    expect(versions.stdout).toMatch(/^\* v2 /m);

    const refused = await sforge(['rollback', 'staging', '--json'], { cwd, providers });
    expect(refused.json().error.code).toBe('SF_CONFIRMATION_REQUIRED');
    const rolled = await sforge(['rollback', 'staging', '--to', 'v1', '--yes'], { cwd, providers });
    expect(rolled.exitCode).toBe(0);
    expect(rolled.stdout).toContain('now serves v1 (was v2)');
    expect(fake.rollbacks).toEqual(['v1']);
  });

  it('builds a preview with the URL the provider will serve it at', async () => {
    const cwd = project({
      prod: { provider: 'azure', resourceGroup: 'rg', location: 'westeurope' },
    });
    const { provider, deploys } = fakeProvider();
    const inner = provider.createDeployer({} as never);
    const azure: Provider = {
      ...provider,
      id: 'azure',
      iac: { ...provider.iac, provider: 'azure' },
      createDeployer: () => ({
        ...inner,
        previewBaseUrl: (id) => `https://app-${id}.westeurope.azurestaticapps.net`,
      }),
    };
    const result = await sforge(['deploy', 'prod', '--preview', 'pr-1', '--no-check', '--json'], {
      cwd,
      env: engineEnv({ output: { stdout: [JSON.stringify(outputs)] } }).env,
      providers: { azure },
    });
    expect(result.exitCode).toBe(0);
    expect(deploys[0]).toMatchObject({ preview: 'pr-1' });
    const home = readFileSync(join(cwd, 'dist', 'index.html'), 'utf8');
    expect(home).toContain('https://app-pr-1.westeurope.azurestaticapps.net/');
  });

  it('builds production with the URL of the target’s domain', async () => {
    const cwd = project({
      staging: { provider: 'aws', region: 'eu-central-1', domain: 'aws.example.org' },
    });
    const { provider, deploys } = fakeProvider();
    const result = await sforge(['deploy', 'staging', '--no-check', '--json'], {
      cwd,
      env: engineEnv({ output: { stdout: [JSON.stringify(outputs)] } }).env,
      providers: { aws: provider },
    });
    expect(result.exitCode).toBe(0);
    expect(deploys).toHaveLength(1);
    const home = readFileSync(join(cwd, 'dist', 'index.html'), 'utf8');
    expect(home).toContain('<link rel="canonical" href="https://aws.example.org/"');
    expect(home).not.toContain('https://www.example.com/');
    expect(readFileSync(join(cwd, 'dist', 'sitemap.xml'), 'utf8')).toContain(
      '<loc>https://aws.example.org/</loc>',
    );
  });

  it('validates preview ids before building', async () => {
    const cwd = provisioned();
    const result = await sforge(['deploy', 'staging', '--preview', 'PR 1', '--json'], {
      cwd,
      providers: { aws: fakeProvider().provider },
    });
    expect(result.json().error.code).toBe('SF_USAGE');
    expect(existsSync(join(cwd, 'dist'))).toBe(false);
  });
});
