import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { configJsonSchema } from '@staticforge/core';
import { run } from '../src/main.js';
import type { Io } from '../src/io.js';

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

interface RunOptions {
  cwd?: string;
  variables?: NodeJS.ProcessEnv;
}

async function sforge(args: string[], { cwd, variables = {} }: RunOptions = {}) {
  const stdout = sink();
  const stderr = sink();
  const io: Io = {
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdinIsTTY: false,
    env: variables,
    cwd: cwd ?? mkdtempSync(join(tmpdir(), 'sforge-cli-')),
  };
  const exitCode = await run(['node', 'sforge', ...args], io);
  return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
}

function projectWith(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'sforge-cli-'));
  writeFileSync(join(dir, 'staticforge.config.json'), JSON.stringify(config));
  return dir;
}

const validConfig = {
  site: { title: 'Site', baseUrl: 'https://example.com' },
  targets: { staging: { provider: 'aws', region: 'eu-central-1' } },
};

describe('sforge CLI', () => {
  it('prints help with exit code 0', async () => {
    const result = await sforge(['--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage: sforge');
  });

  it('emits a JSON envelope for version', async () => {
    const result = await sforge(['version', '--json']);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      command: 'version',
      ok: true,
      data: { version: expect.any(String), node: process.versions.node },
    });
  });

  it('accepts global options before the subcommand', async () => {
    const result = await sforge(['--json', 'version']);
    expect(JSON.parse(result.stdout).command).toBe('version');
  });

  it('validates a config found via --cwd', async () => {
    const dir = projectWith(validConfig);
    const result = await sforge(['config', 'validate', '--json', '--cwd', dir]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).data).toEqual({
      valid: true,
      path: join(dir, 'staticforge.config.json'),
      rootDir: dir,
      targets: ['staging'],
    });
  });

  it('reports invalid config with issue paths and exit code 2', async () => {
    const dir = projectWith({ site: { title: 'Site', baseUrl: 'not a url' } });
    const result = await sforge(['config', 'validate', '--json'], { cwd: dir });
    expect(result.exitCode).toBe(2);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('SF_CONFIG_INVALID');
    expect(envelope.error.details.issues[0].path).toBe('site.baseUrl');
  });

  it('logs errors to stderr and keeps stdout empty in human mode', async () => {
    const result = await sforge(['config', 'validate']);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('No staticforge config found');
    expect(result.stderr).toContain('hint: Run `sforge init`');
  });

  it('resolves `staticforge` imports in a TS config without installing it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sforge-cli-'));
    writeFileSync(
      join(dir, 'staticforge.config.ts'),
      `import { defineConfig } from 'staticforge';
       export default defineConfig({ site: { title: 'TS', baseUrl: 'https://example.com' } });`,
    );
    const result = await sforge(['config', 'validate', '--json', '--config', dir]);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).data.path).toBe(join(dir, 'staticforge.config.ts'));
  });

  it('prints the resolved config with defaults', async () => {
    const dir = projectWith(validConfig);
    const result = await sforge(['config', 'show', '--json'], { cwd: dir });
    expect(JSON.parse(result.stdout).data.config.build.outDir).toBe('dist');
  });

  it('turns usage errors into SF_USAGE with exit code 2', async () => {
    const result = await sforge(['nope', '--json']);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout).error.code).toBe('SF_USAGE');
    expect(result.stderr).toContain("unknown command 'nope'");
  });

  it('rejects unknown schema names', async () => {
    const result = await sforge(['schema', 'nope']);
    expect(result.exitCode).toBe(2);
  });

  it('initializes, adds content and builds a site', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'sforge-cli-'));
    const init = await sforge(['init', 'site', '--title', 'CLI Site', '--json'], { cwd: parent });
    expect(init.exitCode).toBe(0);
    expect(JSON.parse(init.stdout).data.created).toContain('staticforge.config.ts');

    const dir = join(parent, 'site');
    const post = await sforge(['new', 'post', 'first', '--json'], { cwd: dir });
    expect(JSON.parse(post.stdout).data).toEqual({
      file: 'content/blog/first.md',
      url: '/blog/first/',
    });

    const build = await sforge(['build', '--json'], { cwd: dir });
    expect(build.exitCode).toBe(0);
    const envelope = JSON.parse(build.stdout);
    expect(envelope).toMatchObject({
      command: 'build',
      ok: true,
      data: { summary: { error: 0, warning: 0 } },
    });
    expect(envelope.data.pages.map((p: { url: string }) => p.url)).toContain('/blog/first/');
    expect(readFileSync(join(dir, 'dist/blog/first/index.html'), 'utf8')).toContain(
      '<meta name="generator" content="staticforge 0.0.0">',
    );
  });

  it('refuses to init an existing project', async () => {
    const dir = projectWith(validConfig);
    const result = await sforge(['init', '--json'], { cwd: dir });
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout).error.code).toBe('SF_FILE_EXISTS');
  });

  it('exits 1 with diagnostics when the build has errors', async () => {
    const dir = projectWith(validConfig);
    mkdirSync(join(dir, 'content'));
    writeFileSync(join(dir, 'content/index.md'), '<img src="a.png">\n');

    const human = await sforge(['build'], { cwd: dir });
    expect(human.exitCode).toBe(1);
    expect(human.stderr).toContain(
      'error content/index.md:1:1 error img-alt Image has no alt attribute (WCAG 1.1.1)',
    );
    expect(human.stdout).toMatch(/Built 2 pages .* 1 error, 1 warning/);

    const json = await sforge(['build', '--json'], { cwd: dir });
    expect(json.exitCode).toBe(1);
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: false, data: { summary: { error: 1 } } });
    expect(json.stderr).toBe('');
  });

  it('keeps the committed config schema in sync', async () => {
    const committed = JSON.parse(
      readFileSync(new URL('../schema/staticforge.schema.json', import.meta.url), 'utf8'),
    );
    expect(committed, 'run `pnpm schema:generate`').toEqual(configJsonSchema());
  });
});
