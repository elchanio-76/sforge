import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorCode, type Logger, SforgeError } from '@staticforge/core';
import { ensureClient } from './client.js';
import { SWA_CONFIG_FILE } from './swa-config.js';

export interface UploadRequest {
  /** Directory of the files to publish (already without dot-paths). */
  dir: string;
  /** `production`, or the name of a preview environment. */
  environment: string;
  /** Deployment token of the Static Web App. Never logged. */
  token: string;
  env: NodeJS.ProcessEnv;
  logger: Logger;
}

export interface UploadResult {
  /** The URL the deployment client reports, when it does. */
  url?: string;
}

/** Sends a directory to a Static Web App environment. */
export type Uploader = (request: UploadRequest) => Promise<UploadResult>;

const TIMEOUT_MS = 15 * 60_000;

/** Remove ANSI colors and the token from output that is shown to users. */
export function sanitize(output: string, token: string): string {
  return (
    output
      .replaceAll(token, '***')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;]*m/g, '')
      .trim()
  );
}

/**
 * What the client may see of the caller's environment: enough to run a .NET
 * program and reach the network, not the AWS keys or the Cloudflare token a
 * deploy shell may hold.
 */
const PASSED_ENV =
  /^(PATH|HOME|USERPROFILE|TMPDIR|TEMP|TMP|LANG|LC_[A-Z]+|SYSTEMROOT|SystemRoot|COMSPEC|(HTTPS?|NO|ALL)_PROXY|(https?|no|all)_proxy|SSL_CERT_(FILE|DIR)|DOTNET_[A-Z_]+|XDG_[A-Z_]+)$/;

export function clientEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => PASSED_ENV.test(key)));
}

/**
 * Uploads with Microsoft's StaticSitesClient (downloaded and checked by
 * `ensureClient`), configured as the `swa deploy` command does. The token
 * travels in the environment, and the process runs in an empty directory
 * because the client writes `app.zip` there and reads `.github/workflows`.
 */
export const staticSitesClientUploader: Uploader = async ({
  dir,
  environment,
  token,
  env,
  logger,
}) => {
  const binary = await ensureClient({ logger, env });
  const cwd = mkdtempSync(join(tmpdir(), 'sforge-swa-'));
  try {
    const output = await new Promise<{ code: number | null; text: string }>((resolve, reject) => {
      const child = spawn(binary, [], {
        cwd,
        env: {
          ...clientEnv(env),
          DEPLOYMENT_ACTION: 'upload',
          DEPLOYMENT_PROVIDER: 'SwaCli',
          DEPLOYMENT_TOKEN: token,
          REPOSITORY_BASE: cwd,
          APP_LOCATION: dir,
          ...(existsSync(join(dir, SWA_CONFIG_FILE)) && { CONFIG_FILE_LOCATION: dir }),
          SKIP_APP_BUILD: 'true',
          SKIP_API_BUILD: 'true',
          VERBOSE: 'false',
          // Production is the client's default; only a named environment is set.
          ...(environment !== 'production' && { DEPLOYMENT_ENVIRONMENT: environment }),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: TIMEOUT_MS,
      });
      let text = '';
      child.stdout.on('data', (chunk) => (text += String(chunk)));
      child.stderr.on('data', (chunk) => (text += String(chunk)));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, text }));
    });
    const clean = sanitize(output.text, token);
    if (output.code !== 0 || /deployment failed|deployment failure/i.test(clean)) {
      throw new SforgeError(
        ErrorCode.DeployFailed,
        `The Static Web Apps deployment client failed (exit code ${output.code})`,
        {
          details: { output: clean.split('\n').slice(-30).join('\n') },
          hint: 'Run again with --verbose for more output. If the client cannot start, a shared library may be missing (run ldd on the binary under ~/.cache/staticforge/bin).',
        },
      );
    }
    const url = /Visit your site at:\s*(https:\/\/\S+)/.exec(clean)?.[1];
    return url === undefined ? {} : { url };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
};
