import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { Writable } from 'node:stream';
import type { Io } from '../src/io.js';
import { run } from '../src/main.js';

/** Helpers of the live tests (`pnpm test:live`), which run against real clouds. */

export const MINUTE = 60_000;

/** Cloudflare records whose name contains `text`, read with the API token sforge uses. */
export async function cloudflareRecords(zone: string, text: string): Promise<string[]> {
  const api = async (path: string) => {
    const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN ?? ''}` },
    });
    const body = (await response.json()) as { success: boolean; result: unknown };
    if (!body.success) throw new Error(`Cloudflare ${path}: ${JSON.stringify(body)}`);
    return body.result;
  };
  const [found] = (await api(`/zones?name=${zone}`)) as { id: string }[];
  if (found === undefined) throw new Error(`No Cloudflare zone ${zone}`);
  const records = (await api(`/zones/${found.id}/dns_records?per_page=1000`)) as {
    name: string;
    type: string;
  }[];
  return records.filter((r) => r.name.includes(text)).map((r) => `${r.name} ${r.type}`);
}

/** The AWS SDK is a dependency of the AWS provider, not of the CLI. */
export const fromAws = createRequire(new URL('../../providers/aws/package.json', import.meta.url));

export async function cloudAccount(provider: 'aws' | 'azure' | 'firebase'): Promise<string> {
  if (provider === 'firebase') {
    return (
      process.env.SFORGE_LIVE_PROJECT ??
      execFileSync('gcloud', ['config', 'get-value', 'project'], { encoding: 'utf8' }).trim()
    );
  }
  if (provider === 'azure') {
    return execFileSync('az', ['account', 'show', '--query', 'id', '-o', 'tsv'], {
      encoding: 'utf8',
    }).trim();
  }
  const sts = (await import(fromAws.resolve('@aws-sdk/client-sts'))) as {
    STSClient: new (config: object) => { send(command: unknown): Promise<{ Account?: string }> };
    GetCallerIdentityCommand: new (input: object) => unknown;
  };
  const identity = await new sts.STSClient({}).send(new sts.GetCallerIdentityCommand({}));
  return identity.Account ?? '';
}

function sink() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(String(chunk));
      // Show progress: these runs take minutes.
      if (!String(chunk).startsWith('{')) process.stderr.write(chunk);
      done();
    },
  });
  return { stream, text: () => chunks.join('') };
}

export async function sforge(cwd: string, ...args: string[]) {
  const stdout = sink();
  const io: Io = {
    stdout: stdout.stream,
    stderr: sink().stream,
    stdinIsTTY: false,
    env: process.env,
    cwd,
    onShutdown: () => () => {},
    prompt: async () => '',
  };
  const exitCode = await run(['node', 'sforge', ...args, '--json'], io);
  const envelope = JSON.parse(stdout.text());
  if (exitCode !== 0)
    throw new Error(`sforge ${args.join(' ')}: ${JSON.stringify(envelope.error ?? envelope.data)}`);
  return envelope.data;
}

/** Poll `fn` until it stops throwing. */
export async function eventually<T>(fn: () => Promise<T>, timeoutMs = 2 * MINUTE): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
}

export const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
export const commit = (cwd: string, message: string) => {
  git(cwd, 'add', '-A');
  git(
    cwd,
    '-c',
    'user.name=sforge',
    '-c',
    'user.email=sforge@example.com',
    'commit',
    '-qm',
    message,
  );
};
