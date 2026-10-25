import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ErrorCode,
  SforgeError,
  configJsonSchema,
  findConfigFile,
  getTarget,
  loadConfig,
  validateConfig,
} from '../src/index.js';
import { minimalConfig, tempProject } from './helpers.js';

function expectSforgeError(fn: () => unknown, code: string): SforgeError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(SforgeError);
    expect((error as SforgeError).code).toBe(code);
    return error as SforgeError;
  }
  throw new Error('expected an error');
}

describe('validateConfig', () => {
  it('applies defaults to a minimal config', () => {
    const config = validateConfig(minimalConfig);
    expect(config.site.language).toBe('en');
    expect(config.theme).toBe('default');
    expect(config.build).toEqual({
      outDir: 'dist',
      cleanUrls: true,
      trailingSlash: 'always',
      minify: true,
      drafts: false,
      workers: 'auto',
    });
    expect(config.check.wcag).toBe('2.2-AA');
    expect(config.iac.engine).toBe('tofu');
    expect(config.targets).toEqual({});
  });

  it('applies nested defaults inside collections and targets', () => {
    const config = validateConfig({
      ...minimalConfig,
      collections: { blog: { dir: 'content/blog' } },
      targets: {
        staging: {
          provider: 'aws',
          region: 'eu-central-1',
          ci: { repo: 'acme/site' },
        },
        prod: { provider: 'azure', resourceGroup: 'rg-site', location: 'westeurope' },
      },
    });
    expect(config.collections.blog).toEqual({
      dir: 'content/blog',
      sortBy: 'date',
      perPage: 10,
      feed: { rss: true, atom: true },
    });
    expect(config.targets.staging).toMatchObject({
      retainVersions: 10,
      ci: { repo: 'acme/site', branches: ['main'], environments: [], pullRequests: true },
    });
    expect(config.targets.prod).toMatchObject({ provider: 'azure', sku: 'Free' });
  });

  it('reports every issue with a dotted path', () => {
    const error = expectSforgeError(
      () =>
        validateConfig({
          site: { title: '', baseUrl: 'ftp://example.com' },
          targets: { Prod: { provider: 'aws', region: 'eu-central-1' } },
          typo: true,
        }),
      ErrorCode.ConfigInvalid,
    );
    const paths = (error.details as { issues: { path: string }[] }).issues.map((i) => i.path);
    expect(paths).toEqual(
      expect.arrayContaining(['site.title', 'site.baseUrl', 'targets.Prod', '(root)']),
    );
  });

  it('rejects unknown providers and provider-specific keys', () => {
    expectSforgeError(
      () => validateConfig({ ...minimalConfig, targets: { x: { provider: 'gcp' } } }),
      ErrorCode.ConfigInvalid,
    );
    expectSforgeError(
      () =>
        validateConfig({
          ...minimalConfig,
          targets: {
            x: { provider: 'azure', resourceGroup: 'rg', location: 'w', region: 'eu-west-1' },
          },
        }),
      ErrorCode.ConfigInvalid,
    );
  });
});

describe('findConfigFile', () => {
  it('searches parent directories', () => {
    const root = tempProject({
      'staticforge.config.json': '{}',
      'content/blog/post.md': '',
    });
    expect(findConfigFile(join(root, 'content/blog'))).toBe(join(root, 'staticforge.config.json'));
  });

  it('prefers TypeScript over JSON in the same directory', () => {
    const root = tempProject({ 'staticforge.config.json': '{}', 'staticforge.config.ts': '' });
    expect(findConfigFile(root)).toBe(join(root, 'staticforge.config.ts'));
  });

  it('fails with a hint when nothing is found', () => {
    const root = tempProject({});
    const error = expectSforgeError(() => findConfigFile(root), ErrorCode.ConfigNotFound);
    expect(error.hint).toContain('sforge init');
  });

  it('accepts a project directory as the explicit path', () => {
    const root = tempProject({ 'site/staticforge.config.yaml': '' });
    expect(findConfigFile(root, 'site/')).toBe(join(root, 'site/staticforge.config.yaml'));
  });

  it('does not search parents of an explicit directory', () => {
    const root = tempProject({ 'staticforge.config.json': '{}', 'site/index.js': '' });
    const error = expectSforgeError(() => findConfigFile(root, 'site'), ErrorCode.ConfigNotFound);
    expect(error.hint).toContain('staticforge.config.ts');
  });

  it('rejects explicit files of unsupported types', () => {
    const root = tempProject({ 'config.toml': '' });
    expectSforgeError(() => findConfigFile(root, 'config.toml'), ErrorCode.ConfigLoadFailed);
  });

  it('fails for a missing explicit path', () => {
    const root = tempProject({});
    expectSforgeError(() => findConfigFile(root, 'nope.json'), ErrorCode.ConfigNotFound);
  });
});

describe('loadConfig', () => {
  it('loads JSON', async () => {
    const root = tempProject({ 'staticforge.config.json': JSON.stringify(minimalConfig) });
    const loaded = await loadConfig({ cwd: root });
    expect(loaded.rootDir).toBe(root);
    expect(loaded.config.site.title).toBe('Test site');
  });

  it('loads YAML', async () => {
    const root = tempProject({
      'staticforge.config.yaml': 'site:\n  title: Yaml site\n  baseUrl: https://example.com\n',
    });
    expect((await loadConfig({ cwd: root })).config.site.title).toBe('Yaml site');
  });

  it('loads TypeScript with a default export', async () => {
    const root = tempProject({
      'staticforge.config.ts': `
        interface Cfg { site: { title: string; baseUrl: string } }
        const config: Cfg = { site: { title: 'TS site', baseUrl: 'https://example.com' } };
        export default config;
      `,
    });
    expect((await loadConfig({ cwd: root })).config.site.title).toBe('TS site');
  });

  it('requires a default export from JS/TS configs', async () => {
    const root = tempProject({ 'staticforge.config.mjs': 'export const site = {};' });
    await expect(loadConfig({ cwd: root })).rejects.toMatchObject({
      code: ErrorCode.ConfigLoadFailed,
      hint: expect.stringContaining('export default'),
    });
  });

  it('resolves aliased module specifiers in JS/TS configs', async () => {
    const root = tempProject({
      'helper.mjs': 'export const defineConfig = (c) => ({ ...c, theme: "aliased" });',
      'staticforge.config.ts': `
        import { defineConfig } from 'not-installed';
        export default defineConfig({ site: { title: 'A', baseUrl: 'https://example.com' } });
      `,
    });
    const loaded = await loadConfig({
      cwd: root,
      aliases: { 'not-installed': join(root, 'helper.mjs') },
    });
    expect(loaded.config.theme).toBe('aliased');
  });

  it('reports parse failures as load errors', async () => {
    const root = tempProject({ 'staticforge.config.json': '{ not json' });
    await expect(loadConfig({ cwd: root })).rejects.toMatchObject({
      code: ErrorCode.ConfigLoadFailed,
    });
  });
});

describe('getTarget', () => {
  const config = validateConfig({
    ...minimalConfig,
    targets: { staging: { provider: 'aws', region: 'eu-central-1' } },
  });

  it('returns a configured target', () => {
    expect(getTarget(config, 'staging').provider).toBe('aws');
  });

  it('lists known targets when the name is unknown', () => {
    const error = expectSforgeError(() => getTarget(config, 'prod'), ErrorCode.TargetNotFound);
    expect(error.hint).toBe('Known targets: staging');
  });
});

describe('configJsonSchema', () => {
  it('describes the input shape, where defaulted keys are optional', () => {
    const schema = configJsonSchema() as { required?: string[]; $id: string };
    expect(schema.$id).toBe('urn:staticforge:schema:config:v1');
    expect(schema.required).toEqual(['site']);
  });
});
