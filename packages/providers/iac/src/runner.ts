import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ErrorCode, SforgeError } from '@staticforge/core';
import { type Engine, cacheRoot } from './engine.js';

/** One line of the engine's machine-readable UI (`-json`). */
export interface EngineEvent {
  type: string;
  level: string;
  message: string;
  raw: Record<string, unknown>;
}

export interface EngineDiagnostic {
  severity: 'error' | 'warning';
  summary: string;
  detail?: string;
  /** Resource address the diagnostic is about. */
  address?: string;
  file?: string;
  line?: number;
}

export interface RunResult {
  exitCode: number;
  events: EngineEvent[];
  diagnostics: EngineDiagnostic[];
  /** Non-JSON output (all of stdout without `-json`), for parsing or error messages. */
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Parse stdout as `-json` event lines (the caller adds `-json` to args). */
  json?: boolean;
  onEvent?: (event: EngineEvent) => void;
  /** Raw output chunks, for passthrough commands. */
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /** Inherit stdin so the engine can prompt (passthrough commands only). */
  interactive?: boolean;
}

/** Environment for every engine run: non-interactive, no update checks, shared plugin cache. */
export function engineEnv(engine: Engine, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const pluginCache = env.TF_PLUGIN_CACHE_DIR || join(cacheRoot(env), 'plugins', engine.name);
  mkdirSync(pluginCache, { recursive: true });
  return {
    ...env,
    TF_IN_AUTOMATION: '1',
    TF_INPUT: '0',
    CHECKPOINT_DISABLE: '1',
    TF_PLUGIN_CACHE_DIR: pluginCache,
  };
}

function toDiagnostic(raw: Record<string, unknown>): EngineDiagnostic | undefined {
  const d = raw.diagnostic as
    | {
        severity?: string;
        summary?: string;
        detail?: string;
        address?: string;
        range?: { filename?: string; start?: { line?: number } };
      }
    | undefined;
  if (d === undefined || typeof d.summary !== 'string') return undefined;
  return {
    severity: d.severity === 'warning' ? 'warning' : 'error',
    summary: d.summary,
    ...(d.detail && { detail: d.detail }),
    ...(d.address && { address: d.address }),
    ...(d.range?.filename && { file: d.range.filename }),
    ...(d.range?.start?.line !== undefined && { line: d.range.start.line }),
  };
}

/** Text diagnostics ("Error: ...") from runs without `-json`, such as `init`. */
function textDiagnostics(output: string): EngineDiagnostic[] {
  const result: EngineDiagnostic[] = [];
  // eslint-disable-next-line no-control-regex
  const lines = output.replace(/\x1b\[[0-9;]*m/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*[│|]?\s*(Error|Warning): (.+)$/.exec(lines[i]!);
    if (match === null) continue;
    const detail: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const text = lines[j]!.replace(/^\s*[│╵|]\s?/, '');
      if (/^\s*(Error|Warning): /.test(text) || /^\s*╵/.test(lines[j]!)) break;
      detail.push(text);
    }
    result.push({
      severity: match[1] === 'Warning' ? 'warning' : 'error',
      summary: match[2]!.trim(),
      ...(detail.join('\n').trim() !== '' && { detail: detail.join('\n').trim() }),
    });
  }
  return result;
}

/** Run the engine with `args`. Never throws for a non-zero exit: see {@link assertSucceeded}. */
export function runEngine(engine: Engine, args: string[], options: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(engine.path, args, {
      cwd: options.cwd,
      env: engineEnv(engine, options.env ?? process.env),
      stdio: [options.interactive ? 'inherit' : 'ignore', 'pipe', 'pipe'],
    });
    const events: EngineEvent[] = [];
    const diagnostics: EngineDiagnostic[] = [];
    let stdout = '';
    let stderr = '';
    let pending = '';

    const handleLine = (line: string) => {
      if (line.trim() === '') return;
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(line) as Record<string, unknown>;
      } catch {
        stdout += `${line}\n`;
        return;
      }
      const event: EngineEvent = {
        type: typeof raw.type === 'string' ? raw.type : 'log',
        level: typeof raw['@level'] === 'string' ? raw['@level'] : 'info',
        message: typeof raw['@message'] === 'string' ? raw['@message'] : '',
        raw,
      };
      events.push(event);
      if (event.type === 'diagnostic') {
        const diagnostic = toDiagnostic(raw);
        if (diagnostic !== undefined) diagnostics.push(diagnostic);
      }
      options.onEvent?.(event);
    };

    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      options.onStdout?.(chunk);
      if (!options.json) {
        stdout += chunk;
        return;
      }
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      lines.forEach(handleLine);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      options.onStderr?.(chunk);
      stderr += chunk;
    });
    child.on('error', (error) =>
      reject(
        new SforgeError(ErrorCode.EngineMissing, `Could not run ${engine.path}: ${error.message}`, {
          cause: error,
        }),
      ),
    );
    child.on('close', (code) => {
      if (options.json) handleLine(pending);
      if (!options.json || diagnostics.length === 0) {
        diagnostics.push(...textDiagnostics(`${stdout}\n${stderr}`));
      }
      resolve({ exitCode: code ?? 1, events, diagnostics, stdout, stderr });
    });
  });
}

const AUTH_PATTERNS = [
  /no valid credential sources/i,
  /expiredtoken|token (has )?expired|sso session .* expired/i,
  /failed to refresh cached credentials/i,
  /invalidclienttokenid|signaturedoesnotmatch|unrecognizedclientexception/i,
  /could not load credentials|no credentials/i,
  /please run 'az login'|az login|AADSTS\d+/i,
];

/**
 * Throw an SforgeError describing a failed run. Credential problems become
 * SF_CLOUD_AUTH (with a login hint), everything else SF_IAC_FAILED.
 */
export function assertSucceeded(result: RunResult, what: string, okCodes = [0]): void {
  if (okCodes.includes(result.exitCode)) return;
  const errors = result.diagnostics.filter((d) => d.severity === 'error');
  const summary =
    errors.length > 0
      ? errors.map((d) => `${d.summary}${d.address ? ` (${d.address})` : ''}`).join('; ')
      : result.stderr.trim().split('\n').slice(-3).join(' ') || `exit code ${result.exitCode}`;
  const text = errors.map((d) => `${d.summary} ${d.detail ?? ''}`).join('\n') + result.stderr;
  if (AUTH_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new SforgeError(ErrorCode.CloudAuth, `${what} failed: ${summary}`, {
      details: { diagnostics: result.diagnostics },
      hint: 'Sign in to the cloud provider (e.g. `aws sso login`, `az login`) and try again.',
    });
  }
  throw new SforgeError(ErrorCode.IacFailed, `${what} failed: ${summary}`, {
    details: { exitCode: result.exitCode, diagnostics: result.diagnostics },
  });
}
