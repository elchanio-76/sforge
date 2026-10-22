import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

  it('keeps the committed config schema in sync', async () => {
    const committed = JSON.parse(
      readFileSync(new URL('../schema/staticforge.schema.json', import.meta.url), 'utf8'),
    );
    expect(committed, 'run `pnpm schema:generate`').toEqual(configJsonSchema());
  });
});
