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

/** Start the CLI without awaiting it; `shutdown()` simulates Ctrl+C. */
function startSforge(args: string[], { cwd, variables = {} }: RunOptions = {}) {
  const stdout = sink();
  const stderr = sink();
  const handlers: (() => void)[] = [];
  const io: Io = {
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdinIsTTY: false,
    env: variables,
    cwd: cwd ?? mkdtempSync(join(tmpdir(), 'sforge-cli-')),
    onShutdown(handler) {
      handlers.push(handler);
      return () => handlers.splice(handlers.indexOf(handler), 1);
    },
  };
  const exit = run(['node', 'sforge', ...args], io);
  return {
    exit,
    stdout: stdout.text,
    stderr: stderr.text,
    shutdown: () => handlers.splice(0).forEach((h) => h()),
  };
}

async function sforge(args: string[], options: RunOptions = {}) {
  const started = startSforge(args, options);
  const exitCode = await started.exit;
  return { exitCode, stdout: started.stdout(), stderr: started.stderr() };
}

/** Wait until the command has written its JSON envelope (servers write it when ready). */
async function envelopeOf(started: ReturnType<typeof startSforge>) {
  for (let i = 0; i < 200; i++) {
    const text = started.stdout();
    if (text.trim().endsWith('}')) return JSON.parse(text);
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`No envelope; stderr: ${started.stderr()}`);
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
    expect(human.stdout).toMatch(/Built 3 pages .* 1 error, 1 warning/);

    const json = await sforge(['build', '--json'], { cwd: dir });
    expect(json.exitCode).toBe(1);
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: false, data: { summary: { error: 1 } } });
    expect(json.stderr).toBe('');
  });

  it('runs the dev server until shutdown, reporting where it listens', async () => {
    const dir = projectWith(validConfig);
    mkdirSync(join(dir, 'content'));
    writeFileSync(join(dir, 'content/index.md'), '# Live\n');

    const dev = startSforge(['dev', '--port', '0', '--json'], { cwd: dir });
    const envelope = await envelopeOf(dev);
    expect(envelope).toMatchObject({
      command: 'dev',
      ok: true,
      data: { host: '127.0.0.1', rootDir: dir, build: { ok: true } },
    });
    expect(await (await fetch(`${envelope.data.url}/`)).text()).toContain('<h1>Live</h1>');

    dev.shutdown();
    expect(await dev.exit).toBe(0);
    await expect(fetch(`${envelope.data.url}/`)).rejects.toThrow();
  });

  it('previews an existing build, and explains when there is none', async () => {
    const dir = projectWith(validConfig);
    const missing = await sforge(['preview', '--json'], { cwd: dir });
    expect(missing.exitCode).toBe(2);
    expect(JSON.parse(missing.stdout).error.code).toBe('SF_NOT_BUILT');

    mkdirSync(join(dir, 'content'));
    writeFileSync(join(dir, 'content/about.md'), '# About\n');
    expect((await sforge(['build'], { cwd: dir })).exitCode).toBe(0);

    const preview = startSforge(['preview', '--port', '0', '--json'], { cwd: dir });
    const { data } = await envelopeOf(preview);
    expect(data.dir).toBe(join(dir, 'dist'));
    const about = await fetch(`${data.url}/about`, { redirect: 'manual' });
    expect(about.status).toBe(301);
    const missingPage = await fetch(`${data.url}/nope/`);
    expect(missingPage.status).toBe(404);
    expect(await missingPage.text()).toContain('Page not found');
    preview.shutdown();
    expect(await preview.exit).toBe(0);
  });

  it('rejects invalid ports as usage errors', async () => {
    const result = await sforge(['preview', '--port', 'abc']);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('must be an integer from 0 to 65535');
  });

  it('checks a site, with reports for people, CI and agents, and fixes it', async () => {
    const dir = projectWith(validConfig);
    mkdirSync(join(dir, 'content'));
    writeFileSync(join(dir, 'content/index.md'), '# Home\n\n## A\n\n#### B\n\n[gone](/gone/)\n');

    const human = await sforge(['check', '--no-headless'], { cwd: dir });
    expect(human.exitCode).toBe(1);
    expect(human.stdout).toContain(
      'content/index.md\n  5:1     warning Heading level skips from h2 to h4',
    );
    expect(human.stdout).toContain('error   Link to /gone/ does not match any page');
    expect(human.stdout).toMatch(/✖ 1 error, 1 warning, 0 info in 3 pages \(static checks only/);

    const json = await sforge(['check', '--no-headless', '--json'], { cwd: dir });
    expect(json.exitCode).toBe(1);
    expect(JSON.parse(json.stdout)).toMatchObject({
      command: 'check',
      ok: false,
      data: { rendered: 'off', summary: { error: 1, warning: 1 } },
    });

    const sarif = await sforge(
      ['check', '--no-headless', '--json', '--format', 'sarif', '--output', 'check.sarif'],
      { cwd: dir },
    );
    expect(sarif.exitCode).toBe(1);
    expect(JSON.parse(sarif.stdout)).toMatchObject({ command: 'check', ok: false });
    const log = JSON.parse(readFileSync(join(dir, 'check.sarif'), 'utf8'));
    expect(log.runs[0].results.map((r: { ruleId: string }) => r.ruleId)).toEqual([
      'heading-order',
      'link-broken',
    ]);

    const dry = await sforge(['check', '--no-headless', '--fix', '--dry-run'], { cwd: dir });
    expect(dry.stdout).toContain('-#### B\n+### B');
    expect(readFileSync(join(dir, 'content/index.md'), 'utf8')).toContain('#### B');

    const fixed = await sforge(['check', '--no-headless', '--fix'], { cwd: dir });
    expect(fixed.stdout).toContain('Fixed 1 problem in 1 file: content/index.md');
    expect(readFileSync(join(dir, 'content/index.md'), 'utf8')).toContain('\n### B\n');
  });

  it('rejects conflicting check options as usage errors', async () => {
    const dir = projectWith(validConfig);
    const dryRun = await sforge(['check', '--dry-run'], { cwd: dir });
    expect(dryRun.exitCode).toBe(2);
    expect(dryRun.stderr).toContain('--dry-run requires --fix');

    const both = await sforge(['check', '--json', '--format', 'junit'], { cwd: dir });
    expect(both.exitCode).toBe(2);
    expect(JSON.parse(both.stdout).error).toMatchObject({
      code: 'SF_USAGE',
      hint: 'Write the junit report to a file with --output <file>.',
    });
  });

  it('requires Chromium for --headless and in CI, and otherwise skips rendered checks', async () => {
    const dir = projectWith(validConfig);
    mkdirSync(join(dir, 'content'));
    writeFileSync(join(dir, 'content/index.md'), '# Home\n');
    const missing = { SFORGE_CHROMIUM_PATH: '/nonexistent/chromium' };

    const explicit = await sforge(['check', '--headless', '--json'], {
      cwd: dir,
      variables: missing,
    });
    expect(explicit.exitCode).toBe(2);
    expect(JSON.parse(explicit.stdout).error.code).toBe('SF_BROWSER_MISSING');

    const ci = await sforge(['check', '--json'], {
      cwd: dir,
      variables: { ...missing, CI: 'true' },
    });
    expect(JSON.parse(ci.stdout).error.code).toBe('SF_BROWSER_MISSING');

    const local = await sforge(['check', '--json'], { cwd: dir, variables: missing });
    expect(local.exitCode).toBe(0);
    expect(JSON.parse(local.stdout).data).toMatchObject({
      rendered: 'skipped',
      diagnostics: [{ ruleId: 'headless-skipped' }],
    });
  });

  it('prints the check report schema', async () => {
    const result = await sforge(['schema', 'diagnostics']);
    expect(JSON.parse(result.stdout)).toMatchObject({
      $id: 'urn:staticforge:schema:diagnostics:v1',
      $defs: { diagnostic: { required: ['ruleId', 'severity', 'message'] } },
    });
  });

  it('keeps the committed config schema in sync', async () => {
    const committed = JSON.parse(
      readFileSync(new URL('../schema/staticforge.schema.json', import.meta.url), 'utf8'),
    );
    expect(committed, 'run `pnpm schema:generate`').toEqual(configJsonSchema());
  });
});
