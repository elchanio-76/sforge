import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type CallToolResult,
  McpServer,
  type ServerContext,
  type StandardSchemaWithJSON,
  type ToolAnnotations,
  type ToolCallback,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { CheckResult } from '@staticforge/checker';
import { type Diagnostic, ErrorCode } from '@staticforge/core';
import type { Outcome, Runtime } from '../command.js';
import { standaloneDataSchema } from '../schemas.js';
import { VERSION } from '../version.js';
import { type Invocation, type RunCli, invoke } from './invoke.js';

export interface SforgeMcpOptions {
  run: RunCli;
  /** Project directory (or a directory below it). */
  cwd: string;
  /** Global options for every command, e.g. ["--config", "site.yaml"]. */
  globalArgs?: string[];
  env: NodeJS.ProcessEnv;
  /** Also offer provision and destroy. */
  allowInfra?: boolean;
  /** Cloud providers to use instead of the real ones (tests). */
  providers?: Runtime['providers'];
  /** Where command logs go: stderr when serving over stdio. */
  log?(line: string): void;
}

export interface SforgeMcp {
  /** A server with every tool and resource. Over stdio, one connection may create two. */
  createServer(): McpServer;
  /** Stop the dev server, if one is running. */
  close(): Promise<void>;
}

const INSTRUCTIONS = `staticforge (sforge) builds, checks, previews and deploys accessible static sites.
Content lives in content/ (Markdown or HTML with YAML front-matter), assets in assets/, files copied as is in static/, configuration in staticforge.config.*.
A typical loop: edit content, call sforge_check, read the diagnostics (ruleId, severity, file, line, url, selector, wcag, hint), fix them, check again. sforge_fix_preview shows the safe automatic fixes as a diff; sforge_check with fix: true applies them. The checker never invents alt text: describe images yourself.
sforge_dev_start serves the site with live reload at a local URL; call it again for the latest build's problems.
Tools return the same data as \`sforge <command> --json\`. Errors carry a stable code (SF_*) and often a hint.
Deploying, rolling back and removing previews change live sites: ask the user first, then pass confirm: true.
Private targets (targets.<name>.auth) require signing in: sforge_users_list shows who may, sforge_users_invite and sforge_users_remove change it (ask the user first, then pass confirm: true).`;

type Summary = 'text' | 'none' | ((data: never) => string);

const READ_ONLY: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
const LOCAL_WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const CLOUD_READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: true };
const CLOUD_WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

/** Advertise a hand-written JSON Schema. Tests validate real output against it. */
function jsonSchema(schema: Record<string, unknown>): StandardSchemaWithJSON {
  return {
    '~standard': {
      version: 1,
      vendor: 'staticforge',
      validate: (value: unknown) => ({ value }),
      jsonSchema: { input: () => schema, output: () => schema },
    },
  };
}

const value = (description: string) => z.string().min(1).describe(description);
const target = value('Target name from the config (`targets.<name>`), e.g. "staging".');
const confirm = z
  .boolean()
  .optional()
  .describe('Must be true: the user has agreed to this change of a live site.');

type Flags = Record<string, string | number | boolean | string[] | undefined>;

/**
 * argv for a command: options as `--name=value`, then `--` and the positionals,
 * so no value is ever read as an option.
 */
function argv(command: string[], flags: Flags = {}, positionals: string[] = []): string[] {
  const args = [...command];
  for (const [flag, v] of Object.entries(flags)) {
    if (v === undefined || v === false) continue;
    if (v === true) args.push(flag);
    else if (Array.isArray(v)) args.push(...v.map((item) => `${flag}=${item}`));
    else args.push(`${flag}=${v}`);
  }
  return positionals.length > 0 ? [...args, '--', ...positionals] : args;
}

const text = (s: string) => ({ type: 'text' as const, text: s });

function errorResult(
  code: string,
  message: string,
  extra: unknown = { code, message },
): CallToolResult {
  return {
    isError: true,
    content: [text(`${code}: ${message}`), text(JSON.stringify(extra))],
  };
}

/** The tool result for a command outcome: a summary plus the data as JSON, or the error. */
function toolResult(outcome: Outcome, summary: Summary): CallToolResult {
  const { envelope } = outcome;
  if (envelope.error !== undefined) {
    const { code, message, hint } = envelope.error;
    return errorResult(
      code,
      hint === undefined ? message : `${message}\nhint: ${hint}`,
      envelope.error,
    );
  }
  const data = (envelope.data ?? {}) as Record<string, unknown>;
  const line =
    summary === 'none'
      ? undefined
      : summary === 'text'
        ? outcome.text
        : (summary as (data: unknown) => string)(data);
  return {
    content: [...(line !== undefined ? [text(line)] : []), text(JSON.stringify(data))],
    structuredContent: data,
  };
}

function checkSummary(data: CheckResult): string {
  const { error, warning, info } = data.summary;
  const lines = [
    `Checked ${data.pages} page${data.pages === 1 ? '' : 's'}: ${error} error${error === 1 ? '' : 's'}, ` +
      `${warning} warning${warning === 1 ? '' : 's'}, ${info} notice${info === 1 ? '' : 's'} ` +
      `(rendered checks: ${data.rendered}).`,
  ];
  if (data.fixes?.applied === true) {
    lines.push(
      data.fixes.files.length > 0
        ? `Fixed ${data.fixes.files.map((f) => `${f.file} (${f.ruleIds.join(', ')})`).join(', ')}.`
        : 'No automatic fixes applied.',
    );
  }
  return lines.join('\n');
}

function fixPreviewSummary(data: CheckResult): string {
  const diff = data.fixes?.diff ?? '';
  return diff === '' ? 'No automatic fixes apply.' : diff;
}

interface LatestDiagnostics {
  source: 'build' | 'check' | 'dev';
  at: string;
  ok: boolean;
  summary?: unknown;
  diagnostics: Diagnostic[];
}

interface DevSession {
  invocation: Invocation;
  data: () => unknown;
}

export function createSforgeMcp(options: SforgeMcpOptions): SforgeMcp {
  let dev: DevSession | undefined;
  let devStarting: Promise<void> | undefined;
  let latest: LatestDiagnostics | undefined;

  /** Logs go to options.log, and as progress notifications while the request is open. */
  function progress(ctx: ServerContext | undefined) {
    const token = ctx?.mcpReq._meta?.progressToken;
    let step = 0;
    let open = true;
    return {
      onLog(line: string) {
        options.log?.(line);
        if (!open || token === undefined || ctx === undefined) return;
        void ctx.mcpReq
          .notify({
            method: 'notifications/progress',
            params: { progressToken: token, progress: ++step, message: line },
          })
          .catch(() => {});
      },
      end() {
        open = false;
      },
    };
  }

  function start(args: string[], onLog: (line: string) => void): Invocation {
    return invoke(args, {
      run: options.run,
      cwd: options.cwd,
      env: options.env,
      ...(options.globalArgs !== undefined && { globalArgs: options.globalArgs }),
      ...(options.providers && { providers: options.providers }),
      onLog,
    });
  }

  /** Run a command to completion. */
  async function command(args: string[], ctx?: ServerContext): Promise<Outcome> {
    const logs = progress(ctx);
    try {
      const invocation = start(args, logs.onLog);
      const outcome = await invocation.outcome;
      await invocation.done;
      return outcome;
    } finally {
      logs.end();
    }
  }

  function remember(source: LatestDiagnostics['source'], outcome: Outcome): void {
    const data = outcome.envelope.data as
      { ok?: boolean; summary?: unknown; diagnostics?: Diagnostic[] } | undefined;
    if (data?.diagnostics === undefined) return;
    latest = {
      source,
      at: new Date().toISOString(),
      ok: data.ok ?? outcome.envelope.ok,
      ...(data.summary !== undefined && { summary: data.summary }),
      diagnostics: data.diagnostics,
    };
  }

  type DevFlags = { port?: number | undefined; drafts?: boolean | undefined };

  async function startDev(flags: DevFlags, ctx: ServerContext): Promise<CallToolResult> {
    // A call made while another is starting the server waits for it, then reports on it.
    while (devStarting !== undefined) await devStarting;
    if (dev !== undefined) {
      return {
        content: [text('The dev server is already running; this is its latest build.')],
        structuredContent: dev.data() as Record<string, unknown>,
      };
    }
    const starting = launchDev(flags, ctx);
    devStarting = starting.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await starting;
    } finally {
      devStarting = undefined;
    }
  }

  async function launchDev(flags: DevFlags, ctx: ServerContext): Promise<CallToolResult> {
    const logs = progress(ctx);
    const invocation = start(
      argv(['dev'], { '--port': flags.port ?? 0, '--drafts': flags.drafts }),
      logs.onLog,
    );
    try {
      const outcome = await invocation.outcome;
      if (outcome.envelope.error !== undefined) {
        await invocation.done;
        return toolResult(outcome, 'none');
      }
      const session: DevSession = {
        invocation,
        data: outcome.live ?? (() => outcome.envelope.data),
      };
      dev = session;
      void invocation.done.then(() => {
        if (dev === session) dev = undefined;
      });
      return toolResult(outcome, 'text');
    } finally {
      logs.end();
    }
  }

  async function stopDev(): Promise<{ stopped: boolean; url?: string }> {
    const session = dev;
    if (session === undefined) return { stopped: false };
    dev = undefined;
    const { url } = session.data() as { url: string };
    session.invocation.stop();
    await session.invocation.done;
    return { stopped: true, url };
  }

  async function json(args: string[]): Promise<unknown> {
    const { envelope } = await command(args);
    if (envelope.error !== undefined) {
      throw new Error(`${envelope.error.code}: ${envelope.error.message}`);
    }
    return envelope.data;
  }

  function createServer(): McpServer {
    const server = new McpServer(
      { name: 'staticforge', title: 'staticforge', version: VERSION },
      { instructions: INSTRUCTIONS },
    );

    const tool = <I extends z.ZodObject>(
      name: string,
      spec: {
        title: string;
        description: string;
        input: I;
        /** Command whose data schema is the tool's output schema. */
        data: string;
        annotations: ToolAnnotations;
      },
      handler: (args: z.infer<I>, ctx: ServerContext) => Promise<CallToolResult>,
    ): void => {
      server.registerTool(
        name,
        {
          title: spec.title,
          description: spec.description,
          inputSchema: spec.input,
          outputSchema: jsonSchema(standaloneDataSchema(spec.data)),
          annotations: { title: spec.title, ...spec.annotations },
        },
        // The SDK infers the arguments through Standard Schema, which TypeScript cannot
        // relate to z.infer for a generic I.
        (async (args: z.infer<I>, ctx: ServerContext) => {
          try {
            return await handler(args, ctx);
          } catch (error) {
            return errorResult(
              ErrorCode.Internal,
              error instanceof Error ? error.message : String(error),
            );
          }
        }) as ToolCallback<I>,
      );
    };

    tool(
      'sforge_build',
      {
        title: 'Build the site',
        description:
          'Build the site into the output directory (build.outDir, usually dist/). Returns the pages built and the build diagnostics.',
        input: z.object({
          drafts: z.boolean().optional().describe('Include pages marked draft: true.'),
          baseUrl: z
            .url()
            .optional()
            .describe('Site URL for canonical links (default: site.baseUrl).'),
          outDir: value('Output directory (default: build.outDir).').optional(),
        }),
        data: 'build',
        annotations: LOCAL_WRITE,
      },
      async (args, ctx) => {
        const outcome = await command(
          argv(['build'], {
            '--drafts': args.drafts,
            '--base-url': args.baseUrl,
            '--out': args.outDir,
          }),
          ctx,
        );
        remember('build', outcome);
        return toolResult(outcome, 'text');
      },
    );

    const pages = z
      .array(value('A URL or source glob.'))
      .optional()
      .describe(
        'Only check pages whose URL or source matches, e.g. ["/blog/**", "content/about.md"].',
      );

    tool(
      'sforge_check',
      {
        title: 'Check the site',
        description:
          'Build the site into a temporary directory and check it for accessibility (WCAG 2.2 AA) and correctness: HTML validity, links, landmarks, headings, and axe-core in headless Chromium. With fix: true, apply the safe automatic fixes to the sources first. data.ok is false when problems at or above check.failOn remain.',
        input: z.object({
          fix: z
            .boolean()
            .optional()
            .describe('Apply safe fixes to the source files, then check again.'),
          headless: z
            .boolean()
            .optional()
            .describe(
              'Run the rendered checks in headless Chromium (default: check.headless). Slower.',
            ),
          pages,
          failOn: z
            .enum(['error', 'warning'])
            .optional()
            .describe('Threshold for data.ok (default: check.failOn).'),
          drafts: z.boolean().optional().describe('Include pages marked draft: true.'),
        }),
        data: 'check',
        annotations: { ...LOCAL_WRITE, idempotentHint: false },
      },
      async (args, ctx) => {
        const outcome = await command(
          argv(['check'], {
            '--fix': args.fix,
            '--headless': args.headless === true,
            '--no-headless': args.headless === false,
            '--fail-on': args.failOn,
            '--drafts': args.drafts,
            '--pages': args.pages,
          }),
          ctx,
        );
        remember('check', outcome);
        return toolResult(outcome, checkSummary as Summary);
      },
    );

    tool(
      'sforge_fix_preview',
      {
        title: 'Preview automatic fixes',
        description:
          'Show the safe automatic fixes `sforge_check` with fix: true would make, as a unified diff of the source files (data.fixes.diff). Changes nothing.',
        input: z.object({
          pages,
          headless: z
            .boolean()
            .optional()
            .describe('Also run the rendered checks (default: false).'),
        }),
        data: 'check',
        annotations: READ_ONLY,
      },
      async (args, ctx) => {
        const outcome = await command(
          argv(['check'], {
            '--fix': true,
            '--dry-run': true,
            '--headless': args.headless === true,
            '--no-headless': args.headless !== true,
            '--pages': args.pages,
          }),
          ctx,
        );
        remember('check', outcome);
        return toolResult(outcome, fixPreviewSummary as Summary);
      },
    );

    tool(
      'sforge_dev_start',
      {
        title: 'Start the dev server',
        description:
          'Build and serve the site on 127.0.0.1 with live reload; it rebuilds on every file change until sforge_dev_stop. Returns the URL and the first build. If it is already running, returns its latest build, so call it again after editing to see new problems.',
        input: z.object({
          port: z.int().min(0).max(65535).optional().describe('Port (default: 0, a free port).'),
          drafts: z.boolean().optional().describe('Include pages marked draft: true.'),
        }),
        data: 'dev',
        annotations: { ...LOCAL_WRITE, idempotentHint: true },
      },
      (args, ctx) => startDev(args, ctx),
    );

    server.registerTool(
      'sforge_dev_stop',
      {
        title: 'Stop the dev server',
        description: 'Stop the dev server started by sforge_dev_start.',
        inputSchema: z.object({}),
        outputSchema: z.object({ stopped: z.boolean(), url: z.string().optional() }),
        annotations: { title: 'Stop the dev server', ...LOCAL_WRITE },
      },
      async () => {
        const result = await stopDev();
        return {
          content: [
            text(
              result.stopped
                ? `Stopped the dev server at ${result.url}`
                : 'No dev server is running.',
            ),
          ],
          structuredContent: result,
        };
      },
    );

    tool(
      'sforge_new_page',
      {
        title: 'Create a page or post',
        description:
          'Create a Markdown (or HTML) page or blog post under content/ with front-matter. Returns the file and the URL it will have.',
        input: z.object({
          kind: z
            .enum(['page', 'post'])
            .default('page')
            .describe('Posts go to blog/ unless the path has a directory.'),
          path: value('Path inside content/ without extension, e.g. "about" or "guides/setup".'),
          title: z.string().min(1).optional().describe('Title (default: from the path).'),
          format: z.enum(['md', 'html']).optional().describe('Source format (default: md).'),
          draft: z.boolean().optional().describe('Mark as draft.'),
          force: z.boolean().optional().describe('Overwrite an existing file.'),
        }),
        data: 'new',
        annotations: { ...LOCAL_WRITE, idempotentHint: false },
      },
      async (args, ctx) =>
        toolResult(
          await command(
            argv(
              ['new'],
              {
                '--title': args.title,
                '--format': args.format,
                '--draft': args.draft,
                '--force': args.force,
              },
              [args.kind, args.path],
            ),
            ctx,
          ),
          'text',
        ),
    );

    tool(
      'sforge_config',
      {
        title: 'Show the config',
        description:
          'Validate the project config and return it resolved, with defaults applied. Invalid configs return SF_CONFIG_INVALID with the problems.',
        input: z.object({}),
        data: 'config show',
        annotations: READ_ONLY,
      },
      async (_args, ctx) => toolResult(await command(['config', 'show'], ctx), 'none'),
    );

    tool(
      'sforge_schema',
      {
        title: 'Get a JSON Schema',
        description:
          'Return a JSON Schema: "config" (the config file), "diagnostics" (the check report), or "output" (the --json envelope with every command\'s data).',
        input: z.object({ name: z.enum(['config', 'diagnostics', 'output']).default('config') }),
        data: 'schema',
        annotations: READ_ONLY,
      },
      async (args, ctx) => toolResult(await command(['schema', args.name], ctx), 'none'),
    );

    tool(
      'sforge_deploy',
      {
        title: 'Deploy the site',
        description:
          'Build, check and deploy the site to a provisioned target, or deploy a PR preview. Refuses (SF_CHECK_FAILED) when the check finds problems at or above check.failOn. Production deploys switch the live site: ask the user, then pass confirm: true. dryRun shows what would be uploaded without confirmation.',
        input: z.object({
          target,
          preview: value(
            'Deploy a PR preview with this id (e.g. "pr-42") instead of production.',
          ).optional(),
          dryRun: z.boolean().optional().describe('Show what would be uploaded; change nothing.'),
          check: z.boolean().optional().describe('Run the checker first (default: true).'),
          headless: z
            .boolean()
            .optional()
            .describe('Run the rendered checks (default: check.headless).'),
          confirm,
        }),
        data: 'deploy',
        annotations: CLOUD_WRITE,
      },
      async (args, ctx) => {
        if (args.dryRun !== true && args.confirm !== true) {
          return errorResult(
            ErrorCode.ConfirmationRequired,
            `Deploying changes ${args.preview === undefined ? `the live site of "${args.target}"` : `preview ${args.preview}`}. Ask the user, then call again with confirm: true (or use dryRun: true).`,
          );
        }
        return toolResult(
          await command(
            argv(
              ['deploy'],
              {
                '--preview': args.preview,
                '--dry-run': args.dryRun,
                '--no-check': args.check === false,
                '--headless': args.headless === true,
                '--no-headless': args.headless === false,
              },
              [args.target],
            ),
            ctx,
          ),
          'text',
        );
      },
    );

    tool(
      'sforge_status',
      {
        title: 'Target status',
        description:
          "Show a target's URL and active version, and detect infrastructure drift (data.drifted). Runs OpenTofu/Terraform with a refresh-only plan.",
        input: z.object({ target }),
        data: 'status',
        annotations: CLOUD_READ,
      },
      async (args, ctx) =>
        toolResult(await command(argv(['status'], {}, [args.target]), ctx), 'text'),
    );

    tool(
      'sforge_versions',
      {
        title: 'List deployed versions',
        description:
          'List the deployed versions of a target (newest first, the active one marked) and its PR previews.',
        input: z.object({ target }),
        data: 'versions',
        annotations: CLOUD_READ,
      },
      async (args, ctx) =>
        toolResult(await command(argv(['versions'], {}, [args.target]), ctx), 'text'),
    );

    tool(
      'sforge_rollback',
      {
        title: 'Roll back',
        description:
          'Serve an earlier version of a target again (default: the one before the active version; see sforge_versions). Changes the live site: ask the user, then pass confirm: true.',
        input: z.object({ target, to: value('Version id to serve.').optional(), confirm }),
        data: 'rollback',
        annotations: CLOUD_WRITE,
      },
      async (args, ctx) => {
        if (args.confirm !== true) {
          return errorResult(
            ErrorCode.ConfirmationRequired,
            `Rolling back changes the live site of "${args.target}". Ask the user, then call again with confirm: true.`,
          );
        }
        return toolResult(
          await command(argv(['rollback'], { '--yes': true, '--to': args.to }, [args.target]), ctx),
          'text',
        );
      },
    );

    tool(
      'sforge_preview_destroy',
      {
        title: 'Remove a preview',
        description: 'Remove a PR preview of a target. Ask the user, then pass confirm: true.',
        input: z.object({ target, id: value('Preview id, e.g. "pr-42".'), confirm }),
        data: 'preview-destroy',
        annotations: CLOUD_WRITE,
      },
      async (args, ctx) => {
        if (args.confirm !== true) {
          return errorResult(
            ErrorCode.ConfirmationRequired,
            `Removing preview ${args.id} of "${args.target}" cannot be undone. Ask the user, then call again with confirm: true.`,
          );
        }
        return toolResult(
          await command(argv(['preview-destroy'], {}, [args.target, args.id]), ctx),
          'text',
        );
      },
    );

    tool(
      'sforge_users_list',
      {
        title: 'List users of a private site',
        description:
          'List who may sign in to a private target (targets.<name>.auth): Cognito users on AWS, invited "member" users on Azure. SF_UNSUPPORTED for public targets.',
        input: z.object({ target }),
        data: 'users list',
        annotations: CLOUD_READ,
      },
      async (args, ctx) =>
        toolResult(await command(argv(['users', 'list'], {}, [args.target]), ctx), 'text'),
    );

    tool(
      'sforge_users_invite',
      {
        title: 'Invite a user to a private site',
        description:
          'Invite someone to sign in to a private target. AWS: Cognito emails them a temporary password (data.emailed). Azure: returns data.invitationUrl to send them; they sign in with the named provider. Ask the user, then pass confirm: true.',
        input: z.object({
          target,
          user: value('Email address, or a GitHub user name with provider "github".'),
          provider: z
            .enum(['aad', 'github'])
            .optional()
            .describe("Azure sign-in provider (default: the target's first)."),
          expiresHours: z
            .number()
            .int()
            .min(1)
            .max(168)
            .optional()
            .describe('Hours the Azure invitation link stays valid (default 168).'),
          confirm,
        }),
        data: 'users invite',
        annotations: CLOUD_WRITE,
      },
      async (args, ctx) => {
        if (args.confirm !== true) {
          return errorResult(
            ErrorCode.ConfirmationRequired,
            `Inviting ${args.user} gives them access to "${args.target}". Ask the user, then call again with confirm: true.`,
          );
        }
        return toolResult(
          await command(
            argv(
              ['users', 'invite'],
              { '--provider': args.provider, '--expires': args.expiresHours },
              [args.target, args.user],
            ),
            ctx,
          ),
          'text',
        );
      },
    );

    tool(
      'sforge_users_remove',
      {
        title: 'Remove a user from a private site',
        description:
          'Remove someone from a private target. On AWS their current sign-in lasts until it expires (auth.sessionHours). Ask the user, then pass confirm: true.',
        input: z.object({
          target,
          user: value('Email address or GitHub user name.'),
          provider: z
            .enum(['aad', 'github'])
            .optional()
            .describe('Azure sign-in provider of the user.'),
          confirm,
        }),
        data: 'users remove',
        annotations: CLOUD_WRITE,
      },
      async (args, ctx) => {
        if (args.confirm !== true) {
          return errorResult(
            ErrorCode.ConfirmationRequired,
            `Removing ${args.user} from "${args.target}" takes away their access. Ask the user, then call again with confirm: true.`,
          );
        }
        return toolResult(
          await command(
            argv(['users', 'remove'], { '--yes': true, '--provider': args.provider }, [
              args.target,
              args.user,
            ]),
            ctx,
          ),
          'text',
        );
      },
    );

    tool(
      'sforge_users_revoke_sessions',
      {
        title: 'Sign everyone out of a private site',
        description:
          'End every sign-in to a private AWS target by replacing its session key; users sign in again. Use it after sforge_users_remove when access must end now. SF_UNSUPPORTED on Azure, which keeps its own sessions. Ask the user, then pass confirm: true.',
        input: z.object({ target, confirm }),
        data: 'users revoke-sessions',
        annotations: CLOUD_WRITE,
      },
      async (args, ctx) => {
        if (args.confirm !== true) {
          return errorResult(
            ErrorCode.ConfirmationRequired,
            `Revoking sessions signs everyone out of "${args.target}". Ask the user, then call again with confirm: true.`,
          );
        }
        return toolResult(
          await command(argv(['users', 'revoke-sessions'], { '--yes': true }, [args.target]), ctx),
          'text',
        );
      },
    );

    if (options.allowInfra === true) {
      tool(
        'sforge_provision',
        {
          title: 'Provision infrastructure',
          description:
            'Create or update the infrastructure of a target with OpenTofu/Terraform. diff: true only plans. Applying needs confirm: true after the user has seen the plan.',
          input: z.object({
            target,
            diff: z.boolean().optional().describe('Only show what would change.'),
            bootstrapState: z
              .boolean()
              .optional()
              .describe("Create the target's remote state backend first, if missing."),
            confirm,
          }),
          data: 'provision',
          annotations: CLOUD_WRITE,
        },
        async (args, ctx) => {
          if (args.diff !== true && args.confirm !== true) {
            return errorResult(
              ErrorCode.ConfirmationRequired,
              `Provisioning changes the cloud resources of "${args.target}". Show the user the plan (diff: true), then call again with confirm: true.`,
            );
          }
          return toolResult(
            await command(
              argv(
                ['provision'],
                {
                  '--diff': args.diff,
                  '--bootstrap-state': args.bootstrapState,
                  '--yes': args.diff !== true,
                },
                [args.target],
              ),
              ctx,
            ),
            'text',
          );
        },
      );

      tool(
        'sforge_destroy',
        {
          title: 'Destroy infrastructure',
          description:
            'Delete every resource of a target, including its deployed content. Irreversible: only after the user has explicitly asked for it, passing the target name again as confirm.',
          input: z.object({ target, confirm: value('The target name again.') }),
          data: 'destroy',
          annotations: CLOUD_WRITE,
        },
        async (args, ctx) =>
          toolResult(
            await command(argv(['destroy'], { '--confirm': args.confirm }, [args.target]), ctx),
            'text',
          ),
      );
    }

    const resource = (
      name: string,
      uri: string,
      description: string,
      read: () => Promise<unknown>,
    ) =>
      server.registerResource(
        name,
        uri,
        { description, mimeType: 'application/json' },
        async (url) => ({
          contents: [
            {
              uri: url.href,
              mimeType: 'application/json',
              text: JSON.stringify(await read(), null, 2),
            },
          ],
        }),
      );

    resource(
      'config',
      'sforge://config',
      'The resolved project config, with defaults applied.',
      async () => json(['config', 'show']),
    );

    resource(
      'latest-diagnostics',
      'sforge://diagnostics/latest',
      "Problems found by the dev server's latest build, or else by the latest build or check of this session.",
      async () => {
        if (dev !== undefined) {
          const { build } = dev.data() as {
            build: { ok: boolean; summary?: unknown; diagnostics: Diagnostic[] };
          };
          return { source: 'dev', at: new Date().toISOString(), ...build };
        }
        return (
          latest ?? {
            source: null,
            diagnostics: [],
            hint: 'Run sforge_check or sforge_build first.',
          }
        );
      },
    );

    resource(
      'build-manifest',
      'sforge://build-manifest',
      'Every file of the last build with its SHA-256, size and cache class (build.outDir/.sforge/build-manifest.json).',
      async () => {
        const { path, config } = (await json(['config', 'show'])) as {
          path: string;
          config: { build: { outDir: string } };
        };
        const manifest = join(dirname(path), config.build.outDir, '.sforge', 'build-manifest.json');
        if (!existsSync(manifest)) throw new Error('There is no build yet: run sforge_build first');
        return JSON.parse(readFileSync(manifest, 'utf8')) as unknown;
      },
    );

    for (const name of ['config', 'diagnostics', 'output']) {
      resource(
        `schema-${name}`,
        `sforge://schema/${name}`,
        `JSON Schema: sforge schema ${name}.`,
        () => json(['schema', name]),
      );
    }

    return server;
  }

  return { createServer, close: async () => void (await stopDev()) };
}
