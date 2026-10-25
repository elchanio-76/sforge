import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ACTIONS } from '../src/ci/actions.js';
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

async function sforge(args: string[], cwd: string) {
  const stdout = sink();
  const stderr = sink();
  const io: Io = {
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdinIsTTY: false,
    env: {},
    cwd,
    onShutdown: () => () => {},
    prompt: async () => '',
  };
  const exitCode = await run(['node', 'sforge', ...args], io);
  const out = stdout.text();
  if (args.includes('--json')) expectValidEnvelope(JSON.parse(out));
  return { exitCode, stdout: out, json: () => JSON.parse(out) };
}

const repo = 'acme/docs';
const targets = {
  aws: {
    provider: 'aws',
    region: 'eu-north-1',
    domain: 'aws.docs.example.com',
    previewDomain: 'preview.aws.docs.example.com',
    ci: { repo, branches: ['main'] },
  },
  azure: {
    provider: 'azure',
    resourceGroup: 'rg-docs',
    location: 'eastus2',
    ci: { repo, branches: [], environments: ['production'] },
  },
};

/** A git repository with the project at `sub` (the root by default). */
function repository(projectTargets: Record<string, unknown> = targets, sub = '') {
  const root = mkdtempSync(join(tmpdir(), 'sforge-ci-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const dir = join(root, sub);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'staticforge.config.json'),
    JSON.stringify({
      site: { title: 'Docs', baseUrl: 'https://docs.example.com' },
      targets: projectTargets,
    }),
  );
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ private: true, packageManager: 'pnpm@12.15.0' }),
  );
  writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
  return { root, dir };
}

type Workflow = {
  permissions: unknown;
  defaults?: { run: { 'working-directory': string } };
  on: Record<string, unknown>;
  jobs: Record<
    string,
    {
      if?: string;
      needs?: string | string[];
      environment?: string | { name: string };
      permissions: Record<string, string>;
      'timeout-minutes': number;
      steps: { uses?: string; run?: string; with?: Record<string, unknown> }[];
    }
  >;
};

const read = (root: string, name: string) =>
  readFileSync(join(root, '.github', 'workflows', name), 'utf8');
const workflow = (root: string, name: string) => parse(read(root, name)) as Workflow;

describe('sforge ci init', () => {
  it('writes the site, preview cleanup and rollback workflows', async () => {
    const { root, dir } = repository();
    const result = await sforge(['ci', 'init', '--json'], dir);
    expect(result.exitCode).toBe(0);
    expect(result.json().data).toMatchObject({
      directory: '.github/workflows',
      created: [
        '.github/workflows/sforge.yml',
        '.github/workflows/sforge-preview-cleanup.yml',
        '.github/workflows/sforge-rollback.yml',
      ],
      skipped: [],
      targets: [
        { name: 'aws', provider: 'aws', region: 'eu-north-1', branch: 'main', previews: true },
        {
          name: 'azure',
          provider: 'azure',
          environment: 'production',
          branch: 'main',
          previews: true,
        },
      ],
      commands: [],
    });

    const site = workflow(root, 'sforge.yml');
    expect(site.permissions).toEqual({});
    expect(Object.keys(site.on)).toEqual(['pull_request', 'push']);
    expect(Object.keys(site.jobs)).toEqual([
      'check',
      'preview-aws',
      'preview-azure',
      'comment',
      'deploy-aws',
      'deploy-azure',
    ]);
    const { jobs } = site;
    expect(jobs.check!.permissions).toEqual({ contents: 'read', 'security-events': 'write' });
    expect(jobs.check!.steps.map((s) => s.run).filter(Boolean)).toContain(
      'pnpm exec sforge check --headless --format sarif --output sforge.sarif',
    );
    // Only the jobs that sign in to a cloud get an OIDC token.
    for (const [name, job] of Object.entries(jobs)) {
      expect(job.permissions['id-token'] === 'write', name).toBe(
        name.startsWith('preview-') || name.startsWith('deploy-'),
      );
    }
    // Pull requests from forks are built and checked, never deployed.
    for (const name of ['preview-aws', 'preview-azure', 'comment']) {
      expect(jobs[name]!.if).toContain(
        'github.event.pull_request.head.repo.full_name == github.repository',
      );
    }
    expect(jobs['deploy-aws']!.environment).toBeUndefined();
    expect(jobs['deploy-azure']!.environment).toMatchObject({ name: 'production' });
    expect(jobs.comment!.permissions).toEqual({ 'pull-requests': 'write' });
    expect(jobs.comment!.needs).toEqual(['preview-aws', 'preview-azure']);

    const cleanup = workflow(root, 'sforge-preview-cleanup.yml');
    expect(cleanup.on).toEqual({ pull_request: { types: ['closed'] } });
    expect(Object.keys(cleanup.jobs)).toEqual(['remove-aws', 'remove-azure']);

    const rollback = workflow(root, 'sforge-rollback.yml');
    expect(Object.keys(rollback.on)).toEqual(['workflow_dispatch']);
    expect(rollback.jobs['rollback-azure']!.environment).toBe('production');
    // Azure rolls back by rebuilding an older commit: it needs the history.
    expect(rollback.jobs['rollback-azure']!.steps[0]!.with).toEqual({ 'fetch-depth': 0 });
    expect(rollback.jobs['rollback-aws']!.steps[0]!.with).toBeUndefined();

    // A hung step (e.g. an apt mirror) must not hold a runner for GitHub's six hours.
    for (const file of [site, cleanup, rollback]) {
      for (const [name, job] of Object.entries(file.jobs)) {
        expect(job['timeout-minutes'], name).toBeGreaterThan(0);
      }
    }
  });

  it('pins every action to a commit and reads only the variables it lists', async () => {
    const { root, dir } = repository();
    const { variables } = (await sforge(['ci', 'init', '--json'], dir)).json().data as {
      variables: { name: string }[];
    };
    const listed = new Set(variables.map((v) => v.name));
    for (const name of ['sforge.yml', 'sforge-preview-cleanup.yml', 'sforge-rollback.yml']) {
      const text = read(root, name);
      for (const line of text.split('\n').filter((l) => /^\s*(- )?uses: /.test(l))) {
        expect(line, name).toMatch(/uses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
      }
      for (const [, used] of text.matchAll(/vars\.(\w+)/g)) expect(listed, name).toContain(used);
      // Values from the event are passed through env, never pasted into scripts.
      expect(text, name).not.toMatch(/run: .*\$\{\{ (github\.event\.pull_request|inputs)\./);
    }
    expect([...listed]).toEqual([
      'SFORGE_AWS_ROLE_ARN',
      'SFORGE_AZURE_CLIENT_ID',
      'SFORGE_AZURE_TENANT_ID',
      'SFORGE_AZURE_SUBSCRIPTION_ID',
    ]);
  });

  it('prints the variable commands once the targets are provisioned', async () => {
    const { dir } = repository();
    const cache = (target: string, outputs: Record<string, string>) => {
      mkdirSync(join(dir, '.sforge', 'state'), { recursive: true });
      writeFileSync(
        join(dir, '.sforge', 'state', `${target}.json`),
        JSON.stringify({ target, provider: 'x', engine: 'tofu', updatedAt: '', outputs }),
      );
    };
    cache('aws', { ci_role_arn: 'arn:aws:iam::123456789012:role/sforge-docs-aws-deploy' });
    const partly = await sforge(['ci', 'init'], dir);
    expect(partly.stdout).toContain(
      'gh variable set SFORGE_AWS_ROLE_ARN --repo acme/docs --body arn:aws:iam::123456789012:role/sforge-docs-aws-deploy',
    );
    expect(partly.stdout).toContain('Provision azure first');

    cache('azure', {
      ci_client_id: 'c1',
      ci_tenant_id: 't1',
      ci_subscription_id: 's1',
    });
    const result = await sforge(['ci', 'init', '--json'], dir);
    expect(result.json().data.commands).toHaveLength(4);
    expect(result.json().data.skipped).toHaveLength(3);
  });

  it('keeps existing workflows unless forced', async () => {
    const { root, dir } = repository();
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(root, '.github', 'workflows', 'sforge.yml'), 'mine\n');
    const kept = await sforge(['ci', 'init', '--json'], dir);
    expect(kept.json().data.skipped).toEqual(['.github/workflows/sforge.yml']);
    expect(read(root, 'sforge.yml')).toBe('mine\n');
    await sforge(['ci', 'init', '--force'], dir);
    expect(read(root, 'sforge.yml')).toContain('name: Site');
  });

  it('runs in the project directory of a larger repository', async () => {
    const { root, dir } = repository(targets, 'site');
    writeFileSync(join(root, '.nvmrc'), '24\n');
    await sforge(['ci', 'init'], dir);
    const site = workflow(root, 'sforge.yml');
    expect(site.defaults).toEqual({ run: { 'working-directory': 'site' } });
    const steps = site.jobs.check!.steps;
    expect(steps.find((s) => s.uses?.startsWith('pnpm/action-setup'))!.with).toEqual({
      package_json_file: 'site/package.json',
    });
    expect(steps.find((s) => s.uses?.startsWith('actions/setup-node'))!.with).toMatchObject({
      'node-version-file': '.nvmrc',
      'cache-dependency-path': 'site/pnpm-lock.yaml',
    });
    expect(steps.find((s) => s.uses?.includes('upload-sarif'))!.with).toMatchObject({
      sarif_file: 'site/sforge.sarif',
    });
  });

  it('leaves out previews that cannot be served, and npm projects use npx', async () => {
    const { root, dir } = repository({
      staging: { provider: 'aws', region: 'eu-central-1', ci: { repo } },
    });
    await sforge(['ci', 'init', '--package-manager', 'npm'], dir);
    const site = workflow(root, 'sforge.yml');
    expect(Object.keys(site.jobs)).toEqual(['check', 'deploy-staging']);
    expect(existsSync(join(root, '.github', 'workflows', 'sforge-preview-cleanup.yml'))).toBe(
      false,
    );
    expect(read(root, 'sforge.yml')).toContain('npx sforge deploy staging');
    expect(read(root, 'sforge.yml')).toContain('- run: npm ci');
  });

  it('needs targets with a GitHub Actions identity', async () => {
    const { dir } = repository({ staging: { provider: 'aws', region: 'eu-central-1' } });
    const none = await sforge(['ci', 'init', '--json'], dir);
    expect(none.exitCode).toBe(2);
    expect(none.json().error).toMatchObject({ code: 'SF_CONFIG_INVALID' });
    const named = await sforge(['ci', 'init', '--targets', 'staging', '--json'], dir);
    expect(named.json().error).toMatchObject({
      code: 'SF_CONFIG_INVALID',
      message: 'targets.staging has no ci',
    });
  });
});

describe('pinned actions', () => {
  it('are commits with their release versions', () => {
    for (const [name, action] of Object.entries(ACTIONS)) {
      expect(action.sha, name).toMatch(/^[0-9a-f]{40}$/);
      expect(action.version, name).toMatch(/^v\d+\.\d+\.\d+$/);
    }
  });
});
