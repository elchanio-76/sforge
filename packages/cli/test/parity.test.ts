import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { Command } from 'commander';
import type { Provider, UserAdmin } from '@staticforge/provider-api';
import type { Io } from '../src/io.js';
import { createProgram, run } from '../src/main.js';
import { createSforgeMcp } from '../src/mcp/server.js';
import { expectMatchesSchema, expectValidEnvelope } from './schema-validation.js';

/*
 * CLI ↔ MCP parity. Every row runs the command with --json and the tool through
 * an in-memory MCP client, each on its own copy of the same fixture, and
 * compares what they return. The drift guard at the end fails when a command or
 * option is neither mapped to a tool nor listed as deliberately CLI only.
 */

type Fixture = 'site' | 'clean' | 'aws' | 'awsBroken' | 'azure';

function write(dir: string, file: string, content: string) {
  mkdirSync(join(dir, file, '..'), { recursive: true });
  writeFileSync(join(dir, file), content);
}

/** A fixture project: `site` has problems the checker reports and can fix, the others are clean. */
function fixture(kind: Fixture): string {
  const dir = mkdtempSync(join(tmpdir(), 'sforge-parity-'));
  const targets: Record<Fixture, unknown> = {
    site: undefined,
    clean: undefined,
    aws: { staging: { provider: 'aws', region: 'eu-central-1' } },
    awsBroken: { staging: { provider: 'aws', region: 'eu-central-1' } },
    azure: {
      staging: { provider: 'azure', resourceGroup: 'rg', location: 'eastus2', auth: {} },
      public: { provider: 'aws', region: 'eu-central-1' },
    },
  };
  write(
    dir,
    'staticforge.config.json',
    JSON.stringify({
      site: { title: 'Site', baseUrl: 'https://www.example.com' },
      search: { enabled: false },
      check: { headless: false },
      ...(targets[kind] !== undefined && { targets: targets[kind] }),
    }),
  );
  write(
    dir,
    'content/index.md',
    kind === 'site' || kind === 'awsBroken'
      ? '---\ntitle: Home\n---\n\nWelcome.\n\n#### Deep heading\n\n<img src="logo.svg">\n'
      : '---\ntitle: Home\n---\n\nWelcome.\n',
  );
  write(dir, 'content/draft.md', '---\ntitle: Draft\ndraft: true\n---\n\nSoon.\n');
  if (kind === 'aws' || kind === 'awsBroken' || kind === 'azure') {
    write(
      dir,
      '.sforge/state/staging.json',
      JSON.stringify({
        target: 'staging',
        provider: kind === 'azure' ? 'azure' : 'aws',
        engine: 'tofu',
        updatedAt: '',
        outputs: { url: 'https://d111.cloudfront.net' },
      }),
    );
  }
  return dir;
}

const url = 'https://d111.cloudfront.net';

function fakeProviders(): Partial<Record<'aws' | 'azure', Provider>> {
  const aws: Provider = {
    id: 'aws',
    iac: { provider: 'aws', prepare: () => Promise.reject(new Error('not used')) },
    requiredOutputs: [],
    createDeployer: () => ({
      async deploy(o) {
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
  const members = new Set(['ana@example.com']);
  const users: UserAdmin = {
    list: async () => [...members].map((name) => ({ id: name, name, provider: 'aad' })),
    async invite(options) {
      if (members.has(options.user)) {
        const { SforgeError, ErrorCode } = await import('@staticforge/core');
        throw new SforgeError(ErrorCode.UserExists, `${options.user} is already invited`);
      }
      members.add(options.user);
      return {
        user: options.user,
        provider: options.provider ?? 'aad',
        emailed: false,
        invitationUrl: 'https://x.azurestaticapps.net/.auth/invitations/abc',
        expiresAt: '2026-11-03T12:00:00.000Z',
      };
    },
    async remove(user) {
      return members.delete(user);
    },
  };
  const azure: Provider = {
    id: 'azure',
    iac: { provider: 'azure', prepare: () => Promise.reject(new Error('not used')) },
    requiredOutputs: [],
    createDeployer: () => ({}) as never,
    createUserAdmin: () => users,
  };
  return { aws, azure };
}

interface Result {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string; hint?: string; details?: unknown };
}

function sink() {
  const chunks: string[] = [];
  return {
    stream: new Writable({
      write(chunk, _encoding, done) {
        chunks.push(String(chunk));
        done();
      },
    }),
    text: () => chunks.join(''),
  };
}

async function viaCli(cwd: string, args: string[]): Promise<Result & { exitCode: number }> {
  const stdout = sink();
  const io: Io = {
    stdout: stdout.stream,
    stderr: sink().stream,
    stdinIsTTY: false,
    env: {},
    cwd,
    onShutdown: () => () => {},
    prompt: () => Promise.reject(new Error('no prompts in parity tests')),
  };
  const exitCode = await run(['node', 'sforge', '--json', ...args], io, {
    providers: fakeProviders(),
  });
  const envelope = JSON.parse(stdout.text()) as {
    ok: boolean;
    data?: unknown;
    error?: Result['error'];
  };
  expectValidEnvelope(envelope);
  return {
    exitCode,
    ok: envelope.error === undefined,
    ...(envelope.data !== undefined && { data: envelope.data }),
    ...(envelope.error !== undefined && { error: envelope.error }),
  };
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function viaTool(
  cwd: string,
  tool: string,
  args: Record<string, unknown>,
  infra: boolean,
): Promise<Result> {
  const mcp = createSforgeMcp({
    run,
    cwd,
    env: {},
    allowInfra: infra,
    providers: fakeProviders(),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.createServer().connect(serverTransport);
  const client = new Client({ name: 'parity', version: '1.0.0' });
  await client.connect(clientTransport);
  closers.push(async () => {
    await client.close();
    await mcp.close();
  });
  const listed = (await client.listTools()).tools.find((t) => t.name === tool);
  expect(listed, `${tool} is registered`).toBeDefined();
  const result = await client.callTool({ name: tool, arguments: args });
  const texts = (result.content as { type: string; text: string }[]).map((c) => c.text);
  if (result.isError === true) {
    // The last text is the error as JSON when the command produced one.
    const error = JSON.parse(texts.at(-1)!) as Result['error'];
    return { ok: false, error: error! };
  }
  expectMatchesSchema(listed!.outputSchema!, result.structuredContent);
  return { ok: true, data: result.structuredContent };
}

/** Make results comparable: temporary paths, times, ports and durations differ per run. */
function normalize(value: unknown, cwds: string[]): unknown {
  if (value === undefined) return undefined;
  let text = JSON.stringify(value);
  for (const cwd of cwds) text = text.split(cwd).join('<cwd>');
  text = text
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, '<time>')
    .replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<port>')
    .replace(/sforge-parity-\w+/g, 'sforge-parity-<id>');
  return JSON.parse(text, (key, v: unknown) =>
    /(^|[a-z])(ms|duration|durationMs|elapsedMs|elapsed)$/i.test(key) && typeof v === 'number'
      ? 0
      : v,
  );
}

interface Row {
  name: string;
  tool: string;
  args?: Record<string, unknown>;
  cli: string[];
  fixture: Fixture;
  /** Offer the infrastructure tools. */
  infra?: boolean;
  /** Both interfaces must fail with this code (the default: both succeed). */
  fails?: string;
  /** Files whose content must also be equal afterwards. */
  files?: string[];
}

const rows: Row[] = [
  // build
  { name: 'build', tool: 'sforge_build', cli: ['build'], fixture: 'site' },
  {
    name: 'build with drafts and a different output',
    tool: 'sforge_build',
    args: { drafts: true, baseUrl: 'https://other.example.org', outDir: 'out' },
    cli: ['build', '--drafts', '--base-url', 'https://other.example.org', '--out', 'out'],
    fixture: 'site',
  },
  // check
  { name: 'check', tool: 'sforge_check', cli: ['check', '--no-headless'], fixture: 'site' },
  {
    name: 'check with a threshold and a page filter',
    tool: 'sforge_check',
    args: { failOn: 'warning', pages: ['/'], headless: false, drafts: true },
    cli: ['check', '--fail-on', 'warning', '--pages', '/', '--no-headless', '--drafts'],
    fixture: 'site',
  },
  {
    name: 'check --fix',
    tool: 'sforge_check',
    args: { fix: true, headless: false },
    cli: ['check', '--fix', '--no-headless'],
    fixture: 'site',
    files: ['content/index.md'],
  },
  {
    name: 'fix preview',
    tool: 'sforge_fix_preview',
    cli: ['check', '--fix', '--dry-run', '--no-headless'],
    fixture: 'site',
    files: ['content/index.md'],
  },
  // new
  {
    name: 'new page',
    tool: 'sforge_new_page',
    args: { path: 'guides/setup', title: 'Setup' },
    cli: ['new', 'page', 'guides/setup', '--title', 'Setup'],
    fixture: 'clean',
    files: ['content/guides/setup.md'],
  },
  {
    name: 'new HTML draft post',
    tool: 'sforge_new_page',
    args: { kind: 'post', path: 'hello', format: 'html', draft: true },
    cli: ['new', 'post', 'hello', '--format', 'html', '--draft'],
    fixture: 'clean',
    files: ['content/blog/hello.html'],
  },
  {
    name: 'new page over an existing file',
    tool: 'sforge_new_page',
    args: { path: 'index' },
    cli: ['new', 'page', 'index'],
    fixture: 'clean',
    fails: 'SF_FILE_EXISTS',
  },
  {
    name: 'new page outside content/',
    tool: 'sforge_new_page',
    args: { path: '../escape' },
    cli: ['new', 'page', '../escape'],
    fixture: 'clean',
    fails: 'SF_USAGE',
  },
  // config and schema
  { name: 'config', tool: 'sforge_config', cli: ['config', 'show'], fixture: 'clean' },
  ...(['config', 'diagnostics', 'output'] as const).map<Row>((name) => ({
    name: `schema ${name}`,
    tool: 'sforge_schema',
    args: { name },
    cli: ['schema', name],
    fixture: 'clean',
  })),
  // cloud, read-only
  // `status` runs the IaC engine (a refresh-only plan): cloud.test.ts covers it with a fake engine.
  {
    name: 'status of an unknown target',
    tool: 'sforge_status',
    args: { target: 'prod' },
    cli: ['status', 'prod'],
    fixture: 'aws',
    fails: 'SF_TARGET_NOT_FOUND',
  },
  {
    name: 'versions',
    tool: 'sforge_versions',
    args: { target: 'staging' },
    cli: ['versions', 'staging'],
    fixture: 'aws',
  },
  {
    name: 'versions of an unknown target',
    tool: 'sforge_versions',
    args: { target: 'prod' },
    cli: ['versions', 'prod'],
    fixture: 'aws',
    fails: 'SF_TARGET_NOT_FOUND',
  },
  // cloud, changing
  {
    name: 'deploy --dry-run',
    tool: 'sforge_deploy',
    args: { target: 'staging', dryRun: true, headless: false },
    cli: ['deploy', 'staging', '--dry-run', '--no-headless'],
    fixture: 'aws',
  },
  {
    name: 'deploy',
    tool: 'sforge_deploy',
    args: { target: 'staging', confirm: true, headless: false },
    cli: ['deploy', 'staging', '--no-headless'],
    fixture: 'aws',
  },
  {
    name: 'deploy a preview',
    tool: 'sforge_deploy',
    args: { target: 'staging', preview: 'pr-7', confirm: true, headless: false },
    cli: ['deploy', 'staging', '--preview', 'pr-7', '--no-headless'],
    fixture: 'aws',
  },
  {
    name: 'deploy refused by the check',
    tool: 'sforge_deploy',
    args: { target: 'staging', confirm: true, headless: false },
    cli: ['deploy', 'staging', '--no-headless'],
    fixture: 'awsBroken',
    fails: 'SF_CHECK_FAILED',
  },
  {
    name: 'rollback',
    tool: 'sforge_rollback',
    args: { target: 'staging', to: 'v1', confirm: true },
    cli: ['rollback', 'staging', '--to', 'v1', '--yes'],
    fixture: 'aws',
  },
  {
    name: 'preview-destroy',
    tool: 'sforge_preview_destroy',
    args: { target: 'staging', id: 'pr-1', confirm: true },
    cli: ['preview-destroy', 'staging', 'pr-1'],
    fixture: 'aws',
  },
  // users
  {
    name: 'users list',
    tool: 'sforge_users_list',
    args: { target: 'staging' },
    cli: ['users', 'list', 'staging'],
    fixture: 'azure',
  },
  {
    name: 'users list of a public target',
    tool: 'sforge_users_list',
    args: { target: 'public' },
    cli: ['users', 'list', 'public'],
    fixture: 'azure',
    fails: 'SF_UNSUPPORTED',
  },
  {
    name: 'users invite',
    tool: 'sforge_users_invite',
    args: {
      target: 'staging',
      user: 'octocat',
      provider: 'github',
      expiresHours: 24,
      confirm: true,
    },
    cli: ['users', 'invite', 'staging', 'octocat', '--provider', 'github', '--expires', '24'],
    fixture: 'azure',
  },
  {
    name: 'users invite of an existing user',
    tool: 'sforge_users_invite',
    args: { target: 'staging', user: 'ana@example.com', confirm: true },
    cli: ['users', 'invite', 'staging', 'ana@example.com'],
    fixture: 'azure',
    fails: 'SF_USER_EXISTS',
  },
  {
    name: 'users remove',
    tool: 'sforge_users_remove',
    args: { target: 'staging', user: 'ana@example.com', confirm: true },
    cli: ['users', 'remove', 'staging', 'ana@example.com', '--yes'],
    fixture: 'azure',
  },
  {
    name: 'users revoke-sessions on Azure',
    tool: 'sforge_users_revoke_sessions',
    args: { target: 'staging', confirm: true },
    cli: ['users', 'revoke-sessions', 'staging', '--yes'],
    fixture: 'azure',
    fails: 'SF_UNSUPPORTED',
  },
  // confirmation: unconfirmed calls change nothing and say so with the same code
  {
    name: 'rollback without confirmation',
    tool: 'sforge_rollback',
    args: { target: 'staging' },
    cli: ['rollback', 'staging'],
    fixture: 'aws',
    fails: 'SF_CONFIRMATION_REQUIRED',
  },
  {
    name: 'users remove without confirmation',
    tool: 'sforge_users_remove',
    args: { target: 'staging', user: 'ana@example.com' },
    cli: ['users', 'remove', 'staging', 'ana@example.com'],
    fixture: 'azure',
    fails: 'SF_CONFIRMATION_REQUIRED',
  },
  // infrastructure tools
  {
    name: 'destroy with the wrong target name',
    tool: 'sforge_destroy',
    args: { target: 'staging', confirm: 'prod' },
    cli: ['destroy', 'staging', '--confirm', 'prod'],
    fixture: 'aws',
    infra: true,
    fails: 'SF_CONFIRMATION_REQUIRED',
  },
  {
    name: 'provision an unknown target',
    tool: 'sforge_provision',
    args: { target: 'prod', diff: true },
    cli: ['provision', 'prod', '--diff'],
    fixture: 'aws',
    infra: true,
    fails: 'SF_TARGET_NOT_FOUND',
  },
];

function files(dir: string, names: string[]): Record<string, string | null> {
  return Object.fromEntries(
    names.map((name) => {
      try {
        return [name, readFileSync(join(dir, name), 'utf8')];
      } catch {
        return [name, null];
      }
    }),
  );
}

describe('CLI ↔ MCP parity', () => {
  it.each(rows)('$name', async (row) => {
    const cliDir = fixture(row.fixture);
    const mcpDir = fixture(row.fixture);
    const cli = await viaCli(cliDir, row.cli);
    const tool = await viaTool(mcpDir, row.tool, row.args ?? {}, row.infra === true);
    const cwds = [cliDir, mcpDir];

    if (row.fails === undefined) {
      expect(cli.error, 'the command succeeds').toBeUndefined();
      expect(tool.error, 'the tool succeeds').toBeUndefined();
      expect(normalize(tool.data, [mcpDir])).toEqual(normalize(cli.data, [cliDir]));
    } else {
      expect(cli.error?.code, 'CLI error code').toBe(row.fails);
      expect(tool.error?.code, 'tool error code').toBe(row.fails);
      expect(cli.exitCode, 'the CLI exits non-zero').not.toBe(0);
      // A refused confirmation differs on purpose: the CLI says "pass --yes", the tool
      // tells the agent to ask the user.
      if (row.fails !== 'SF_CONFIRMATION_REQUIRED') {
        expect(normalize(tool.error?.hint, cwds)).toEqual(normalize(cli.error?.hint, cwds));
      }
    }
    if (row.files !== undefined) {
      expect(normalize(files(mcpDir, row.files), [mcpDir])).toEqual(
        normalize(files(cliDir, row.files), [cliDir]),
      );
    }
    // A failed run leaves the same files behind as the CLI does.
    expect(readdirSync(mcpDir).sort()).toEqual(readdirSync(cliDir).sort());
  });
});

// ---------------------------------------------------------------------------
// Drift guard
// ---------------------------------------------------------------------------

/** Commands (and their options) without a tool, and why. */
const CLI_ONLY: Record<string, string> = {
  init: 'creates a project: an agent works inside one that exists',
  preview: 'serves a build until stopped; `sforge_dev_start` covers the loop',
  iac: 'passes raw arguments to OpenTofu/Terraform',
  'ci init': 'writes workflow files; a one-time setup done by a person',
  'config validate': 'a subset of `config show`, which a tool covers',
  version: '`--version`; the MCP handshake carries the version',
  mcp: 'starts the server itself',
  // Command groups only print their subcommands.
  users: 'group',
  config: 'group',
  ci: 'group',
};

/** Tool for each command that has one. */
const MAPPED: Record<string, string> = {
  build: 'sforge_build',
  check: 'sforge_check',
  dev: 'sforge_dev_start',
  new: 'sforge_new_page',
  'config show': 'sforge_config',
  schema: 'sforge_schema',
  deploy: 'sforge_deploy',
  status: 'sforge_status',
  versions: 'sforge_versions',
  rollback: 'sforge_rollback',
  'preview-destroy': 'sforge_preview_destroy',
  'users list': 'sforge_users_list',
  'users invite': 'sforge_users_invite',
  'users remove': 'sforge_users_remove',
  'users revoke-sessions': 'sforge_users_revoke_sessions',
  provision: 'sforge_provision',
  destroy: 'sforge_destroy',
};

function commands(program: Command): Command[] {
  return program.commands.flatMap((c) => [c, ...commands(c)]);
}

function path(command: Command): string {
  const names: string[] = [];
  for (let c: Command | null = command; c?.parent; c = c.parent) names.unshift(c.name());
  return names.join(' ');
}

describe('CLI ↔ MCP drift guard', () => {
  const program = createProgram({ io: {} as Io, exitCode: 0 });

  it('maps or explains every command', () => {
    const known = new Set([...Object.keys(MAPPED), ...Object.keys(CLI_ONLY)]);
    const found = commands(program).map(path);
    expect(
      found.filter((name) => !known.has(name)),
      'commands with no tool and no reason',
    ).toEqual([]);
    expect(
      [...known].filter((name) => !found.includes(name)),
      'stale entries',
    ).toEqual([]);
  });

  it('registers exactly the mapped tools', async () => {
    const mcp = createSforgeMcp({ run, cwd: tmpdir(), env: {}, allowInfra: true });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcp.createServer().connect(serverTransport);
    const client = new Client({ name: 'drift', version: '1.0.0' });
    await client.connect(clientTransport);
    closers.push(async () => {
      await client.close();
      await mcp.close();
    });
    const names = (await client.listTools()).tools.map((t) => t.name);
    // Tools that have no command of their own.
    const extra = ['sforge_fix_preview', 'sforge_dev_stop'];
    expect(names.sort()).toEqual([...Object.values(MAPPED), ...extra].sort());
  });

  it('accounts for every option of a mapped command', () => {
    // Options a tool does not offer, with the reason. A new option fails this
    // test until it gets a tool parameter or an entry here.
    const unmapped: Record<string, Record<string, string>> = {
      build: { '--workers': 'tuning: the config has build.workers' },
      check: {
        '--format': 'the tool returns structured data, never text formats',
        '--output': 'the tool returns the report, it does not write files',
        '--workers': 'tuning: the config has build.workers',
        '--dry-run': 'offered as sforge_fix_preview',
      },
      dev: {
        '--workers': 'tuning: the config has build.workers',
        '--host': 'the tool serves on 127.0.0.1 only',
        '--open': 'there is no browser to open',
      },
      deploy: {
        '--no-build': 'the tool always builds, so what is deployed was checked',
        '--invalidate': 'normally unnecessary',
        '--workers': 'tuning: the config has build.workers',
      },
      provision: {
        '--local-state': 'state stays remote when an agent provisions',
        '--force-local-state': 'state stays remote when an agent provisions',
        '--no-wait': 'the tool waits for the result',
        '--yes': 'the tool passes it after `confirm`',
      },
      status: {
        '--local-state': 'state stays remote when an agent provisions',
        '--force-local-state': 'state stays remote when an agent provisions',
      },
      destroy: {
        '--local-state': 'state stays remote when an agent provisions',
        '--force-local-state': 'state stays remote when an agent provisions',
      },
      rollback: { '--yes': 'the tool passes it after `confirm`' },
      'users remove': { '--yes': 'the tool passes it after `confirm`' },
      'users revoke-sessions': { '--yes': 'the tool passes it after `confirm`' },
    };
    const problems: string[] = [];
    for (const command of commands(program)) {
      const name = path(command);
      if (MAPPED[name] === undefined) continue;
      for (const option of command.options) {
        if (unmapped[name]?.[option.long ?? option.short ?? ''] === undefined) {
          const flag = option.long ?? option.short ?? '';
          if (!mappedOptions(name).includes(flag)) problems.push(`${name} ${flag}`);
        }
      }
    }
    expect(problems, 'options with neither a tool parameter nor a reason').toEqual([]);
  });
});

/** Options each tool maps (the flags its handler passes), checked against the source. */
function mappedOptions(command: string): string[] {
  const source = readFileSync(new URL('../src/mcp/server.ts', import.meta.url), 'utf8');
  const tool = MAPPED[command]!;
  // The dev server's flags are passed where it is launched, not in the tool's handler.
  const from =
    command === 'dev' ? source.indexOf('async function launchDev') : source.indexOf(`'${tool}'`);
  const next = source.indexOf("\n    tool(\n      'sforge_", from + 1);
  const body = source.slice(from, next === -1 ? undefined : next);
  return [...body.matchAll(/'(--[a-z-]+)'/g)].map((m) => m[1]!);
}
