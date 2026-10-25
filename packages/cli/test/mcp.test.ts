import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { DeployOptions, Provider } from '@staticforge/provider-api';
import { run } from '../src/main.js';
import { type SforgeMcpOptions, createSforgeMcp } from '../src/mcp/server.js';
import { expectMatchesSchema } from './schema-validation.js';

function project(extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sforge-mcp-'));
  writeFileSync(
    join(dir, 'staticforge.config.json'),
    JSON.stringify({
      site: { title: 'Site', baseUrl: 'https://www.example.com' },
      search: { enabled: false },
      check: { headless: false },
      ...extra,
    }),
  );
  mkdirSync(join(dir, 'content'));
  writeFileSync(
    join(dir, 'content', 'index.md'),
    '---\ntitle: Home\n---\n\nWelcome.\n\n#### Deep heading\n\n<img src="logo.svg">\n',
  );
  writeFileSync(
    join(dir, 'content', 'logo.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>\n',
  );
  return dir;
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function connect(options: Partial<SforgeMcpOptions> & { cwd: string }) {
  const logs: string[] = [];
  const mcp = createSforgeMcp({ run, env: {}, log: (line) => logs.push(line), ...options });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.createServer().connect(serverTransport);
  const client = new Client({ name: 'sforge-test', version: '1.0.0' });
  await client.connect(clientTransport);
  closers.push(async () => {
    await client.close();
    await mcp.close();
  });

  const schemas = new Map<string, Record<string, unknown>>();
  for (const tool of (await client.listTools()).tools) {
    if (tool.outputSchema) schemas.set(tool.name, tool.outputSchema);
  }

  /** Call a tool; successful results must match the tool's advertised output schema. */
  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    const texts = (result.content as { type: string; text: string }[]).map((c) => c.text);
    if (!result.isError) expectMatchesSchema(schemas.get(name)!, result.structuredContent);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { ...result, data: result.structuredContent as any, texts };
  }

  async function resource(uri: string) {
    const { contents } = await client.readResource({ uri });
    return JSON.parse((contents[0] as { text: string }).text);
  }

  return { client, call, resource, logs };
}

describe('sforge mcp', () => {
  it('offers tools with output schemas, and the infrastructure tools only when allowed', async () => {
    const cwd = project();
    const { client } = await connect({ cwd });
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'sforge_build',
        'sforge_check',
        'sforge_fix_preview',
        'sforge_dev_start',
        'sforge_dev_stop',
        'sforge_new_page',
        'sforge_config',
        'sforge_schema',
        'sforge_deploy',
        'sforge_status',
        'sforge_versions',
        'sforge_rollback',
        'sforge_preview_destroy',
      ]),
    );
    expect(names).not.toContain('sforge_provision');
    expect(names).not.toContain('sforge_destroy');
    for (const tool of tools) expect(tool.outputSchema?.type, tool.name).toBe('object');
    expect(tools.find((t) => t.name === 'sforge_fix_preview')?.annotations?.readOnlyHint).toBe(
      true,
    );
    expect(tools.find((t) => t.name === 'sforge_deploy')?.annotations?.destructiveHint).toBe(true);

    const infra = await connect({ cwd, allowInfra: true });
    const all = (await infra.client.listTools()).tools.map((t) => t.name);
    expect(all).toEqual(expect.arrayContaining(['sforge_provision', 'sforge_destroy']));
  });

  it('builds, checks, previews fixes and applies them', async () => {
    const cwd = project();
    const { call, resource } = await connect({ cwd });

    const build = await call('sforge_build');
    expect(build.isError).toBeFalsy();
    expect(build.texts[0]).toMatch(/^Built \d+ pages? /);
    expect(build.data.pages.map((p: { url: string }) => p.url)).toContain('/');
    expect(JSON.parse(build.texts[1]!)).toEqual(build.data);
    expect(await resource('sforge://build-manifest')).toMatchObject({
      files: { 'index.html': { cache: 'revalidate' } },
    });

    const check = await call('sforge_check');
    expect(check.isError).toBeFalsy();
    expect(check.data.ok).toBe(false);
    const rules = check.data.diagnostics.map((d: { ruleId: string }) => d.ruleId);
    expect(rules).toEqual(expect.arrayContaining(['img-alt', 'heading-order']));
    expect(check.texts[0]).toMatch(/^Checked \d+ pages?: [1-9]\d* errors?/);
    expect(await resource('sforge://diagnostics/latest')).toMatchObject({
      source: 'check',
      ok: false,
      diagnostics: expect.arrayContaining([expect.objectContaining({ ruleId: 'img-alt' })]),
    });

    const source = join(cwd, 'content', 'index.md');
    const preview = await call('sforge_fix_preview');
    expect(preview.texts[0]).toContain('+## Deep heading');
    expect(preview.data.fixes).toMatchObject({ applied: false });
    expect(readFileSync(source, 'utf8')).toContain('#### Deep heading');

    const fixed = await call('sforge_check', { fix: true });
    expect(fixed.texts[0]).toMatch(/Fixed content\/index\.md \(heading-order\)/);
    expect(readFileSync(source, 'utf8')).toContain('\n## Deep heading');
    // Alt text needs a person: it is still reported.
    expect(fixed.data.diagnostics.map((d: { ruleId: string }) => d.ruleId)).toContain('img-alt');
  });

  it('creates pages, shows the config and reports errors with their codes', async () => {
    const cwd = project();
    const { call, resource } = await connect({ cwd });

    const created = await call('sforge_new_page', { path: 'guides/setup', title: 'Setup' });
    expect(created.data).toEqual({ file: 'content/guides/setup.md', url: '/guides/setup/' });
    expect(readFileSync(join(cwd, 'content', 'guides', 'setup.md'), 'utf8')).toContain(
      'title: Setup',
    );
    const again = await call('sforge_new_page', { path: 'guides/setup' });
    expect(again.isError).toBe(true);
    expect(again.texts[0]).toMatch(/^SF_FILE_EXISTS: /);

    const config = await call('sforge_config');
    expect(config.data.config.site.title).toBe('Site');
    expect(config.texts).toHaveLength(1);
    expect((await resource('sforge://config')).config.build.outDir).toBe('dist');

    const schema = await call('sforge_schema', { name: 'output' });
    expect(schema.data.$id).toBe('urn:staticforge:schema:output:v1');
    expect((await resource('sforge://schema/diagnostics')).$id).toBe(
      'urn:staticforge:schema:diagnostics:v1',
    );

    writeFileSync(join(cwd, 'staticforge.config.json'), JSON.stringify({ site: { title: 1 } }));
    const invalid = await call('sforge_config');
    expect(invalid.isError).toBe(true);
    expect(invalid.texts[0]).toMatch(/^SF_CONFIG_INVALID: /);
    expect(JSON.parse(invalid.texts[1]!)).toMatchObject({ code: 'SF_CONFIG_INVALID' });

    const unknown = await call('sforge_new_page', { kind: 'chapter', path: 'x' });
    expect(unknown.isError).toBe(true);
  });

  it('runs the dev server until it is stopped', async () => {
    const cwd = project();
    const { call, resource } = await connect({ cwd });

    // Two calls at once start one server.
    const [started, twin] = await Promise.all([call('sforge_dev_start'), call('sforge_dev_start')]);
    expect(started.isError, started.texts.join('\n')).toBeFalsy();
    expect(twin.data.url).toBe(started.data.url);
    const url = started.data.url as string;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await (await fetch(url)).text()).toContain('Welcome.');
    expect(started.data.build.diagnostics.map((d: { ruleId: string }) => d.ruleId)).toContain(
      'img-alt',
    );

    const again = await call('sforge_dev_start');
    expect(again.texts[0]).toMatch(/already running/);
    expect(again.data.url).toBe(url);
    expect(await resource('sforge://diagnostics/latest')).toMatchObject({ source: 'dev' });

    expect((await call('sforge_dev_stop')).data).toEqual({ stopped: true, url });
    await expect(fetch(url)).rejects.toThrow();
    expect((await call('sforge_dev_stop')).data).toEqual({ stopped: false });
  });

  it('reports progress while a command runs, with the global options of `sforge mcp`', async () => {
    const cwd = project();
    const { client, logs } = await connect({ cwd, globalArgs: ['--verbose'] });
    const messages: string[] = [];
    await client.callTool(
      { name: 'sforge_build', arguments: {} },
      { onprogress: (p) => void (p.message !== undefined && messages.push(p.message)) },
    );
    expect(logs).toContain('debug parsed content/index.md → /');
    expect(messages).toEqual(logs);
  });

  describe('cloud tools', () => {
    function provisioned() {
      const cwd = project({ targets: { staging: { provider: 'aws', region: 'eu-central-1' } } });
      // A site without problems, so the pre-deploy check passes.
      writeFileSync(join(cwd, 'content', 'index.md'), '---\ntitle: Home\n---\n\nWelcome.\n');
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

    function fakeAws() {
      const deploys: DeployOptions[] = [];
      const rollbacks: (string | undefined)[] = [];
      const url = 'https://d111.cloudfront.net';
      const provider: Provider = {
        id: 'aws',
        iac: {
          provider: 'aws',
          prepare: () => Promise.reject(new Error('not used: outputs are cached')),
        },
        requiredOutputs: [],
        createDeployer: () => ({
          async deploy(o) {
            deploys.push(o);
            return {
              target: 'staging',
              provider: 'aws',
              versionId: o.preview ?? 'v2',
              url,
              preview: o.preview !== undefined,
              uploaded: 3,
              copied: 1,
              skipped: 0,
              deleted: 0,
              bytes: 2048,
              pruned: [],
              invalidated: false,
              dryRun: o.dryRun === true,
              previousVersionId: 'v1',
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
            return { target: 'staging', versionId: to ?? 'v1', previousVersionId: 'v2', url };
          },
          async destroyPreview(id) {
            return { target: 'staging', previewId: id, deleted: 3, existed: true };
          },
          async current() {
            return { url, versionId: 'v2' };
          },
        }),
      };
      return { provider, deploys, rollbacks };
    }

    it('deploys and rolls back only once confirmed', async () => {
      const cwd = provisioned();
      const fake = fakeAws();
      const { call } = await connect({ cwd, providers: { aws: fake.provider } });

      const refused = await call('sforge_deploy', { target: 'staging' });
      expect(refused.isError).toBe(true);
      expect(refused.texts[0]).toMatch(/^SF_CONFIRMATION_REQUIRED: /);
      expect(fake.deploys).toHaveLength(0);

      const dry = await call('sforge_deploy', { target: 'staging', dryRun: true, headless: false });
      expect(dry.isError, dry.texts.join('\n')).toBeFalsy();
      expect(dry.data).toMatchObject({ dryRun: true, check: { summary: { error: 0 } } });

      const deployed = await call('sforge_deploy', {
        target: 'staging',
        confirm: true,
        headless: false,
      });
      expect(deployed.data).toMatchObject({ versionId: 'v2', buildDir: join(cwd, 'dist') });
      expect(deployed.texts[0]).toMatch(/^Deployed version v2 to "staging"/);
      expect(fake.deploys.map((d) => d.dryRun)).toEqual([true, false]);
      expect(existsSync(join(cwd, 'dist', 'index.html'))).toBe(true);

      const versions = await call('sforge_versions', { target: 'staging' });
      expect(versions.data.versions.map((v: { id: string }) => v.id)).toEqual(['v2', 'v1']);

      expect((await call('sforge_rollback', { target: 'staging' })).isError).toBe(true);
      expect(fake.rollbacks).toHaveLength(0);
      const rolledBack = await call('sforge_rollback', {
        target: 'staging',
        to: 'v1',
        confirm: true,
      });
      expect(rolledBack.data).toMatchObject({ versionId: 'v1', previousVersionId: 'v2' });
      expect(fake.rollbacks).toEqual(['v1']);

      expect(
        (await call('sforge_preview_destroy', { target: 'staging', id: 'pr-1' })).isError,
      ).toBe(true);
      const removed = await call('sforge_preview_destroy', {
        target: 'staging',
        id: 'pr-1',
        confirm: true,
      });
      expect(removed.data).toEqual({
        target: 'staging',
        previewId: 'pr-1',
        deleted: 3,
        existed: true,
      });

      const missing = await call('sforge_versions', { target: 'prod' });
      expect(missing.texts[0]).toMatch(/^SF_TARGET_NOT_FOUND: /);
    });
  });
});
