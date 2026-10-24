import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { ErrorCode, SforgeError } from '@staticforge/core';

export interface UploadRequest {
  /** Directory of the files to publish (already without dot-paths). */
  dir: string;
  /** `production`, or the name of a preview environment. */
  environment: string;
  /** Deployment token of the Static Web App. Never logged. */
  token: string;
  env: NodeJS.ProcessEnv;
}

export interface UploadResult {
  /** The URL the deployment client reports, when it does. */
  url?: string;
}

/** Sends a directory to a Static Web App environment. */
export type Uploader = (request: UploadRequest) => Promise<UploadResult>;

const TIMEOUT_MS = 15 * 60_000;

/** Entry point of the `swa` command line shipped as a dependency. */
function swaBinary(): string {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve('@azure/static-web-apps-cli/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { bin: { swa: string } };
  return join(dirname(manifestPath), manifest.bin.swa);
}

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
 * Uploads with `swa deploy`, which downloads and runs Microsoft's
 * StaticSitesClient. The token travels in the environment, and the process runs
 * in an empty directory so it cannot pick up a project's `.github/workflows`.
 */
export const swaCliUploader: Uploader = async ({ dir, environment, token, env }) => {
  const cwd = mkdtempSync(join(tmpdir(), 'sforge-swa-'));
  try {
    const output = await new Promise<{ code: number | null; text: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [swaBinary(), 'deploy', dir, '--env', environment, '--no-use-keychain'],
        {
          cwd,
          env: { ...env, SWA_CLI_DEPLOYMENT_TOKEN: token, FORCE_COLOR: '0', CI: 'true' },
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: TIMEOUT_MS,
        },
      );
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
          hint: 'Run again with --verbose for more output. The client is downloaded on first use: check that you have network access.',
        },
      );
    }
    const url = /Project deployed to\s+(https:\/\/\S+)/.exec(clean)?.[1];
    return url === undefined ? {} : { url };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
};
