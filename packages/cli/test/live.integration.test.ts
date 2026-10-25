import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Io } from '../src/io.js';
import { run } from '../src/main.js';

/**
 * The full cycle against a real cloud: provision → deploy twice → HTTP checks →
 * rollback → destroy. Creates real (cheap) resources, so it only runs with
 * SFORGE_LIVE=aws|azure and SFORGE_LIVE_CONFIRM set to the account or
 * subscription id it will use (`pnpm test:live`; see docs/content/deploy.md).
 *
 * With SFORGE_LIVE_DOMAIN (a parent such as aws.sforge.example.com) and
 * SFORGE_LIVE_DNS_ZONE (its Cloudflare zone), the target gets the custom domain
 * t-<id>.<parent> with records in Cloudflare (CLOUDFLARE_API_TOKEN), and on AWS
 * previews on *.p-<id>.<parent>.
 */
const provider = process.env.SFORGE_LIVE as 'aws' | 'azure' | undefined;
const parentDomain = process.env.SFORGE_LIVE_DOMAIN;
const dnsZone = process.env.SFORGE_LIVE_DNS_ZONE;
const MINUTE = 60_000;

/** Cloudflare records whose name contains `text`, read with the API token sforge uses. */
async function cloudflareRecords(zone: string, text: string): Promise<string[]> {
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

async function cloudAccount(): Promise<string> {
  if (provider === 'azure') {
    return execFileSync('az', ['account', 'show', '--query', 'id', '-o', 'tsv'], {
      encoding: 'utf8',
    }).trim();
  }
  // The AWS SDK is a dependency of the AWS provider, not of the CLI.
  const fromAws = createRequire(new URL('../../providers/aws/package.json', import.meta.url));
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

async function sforge(cwd: string, ...args: string[]) {
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
async function eventually<T>(fn: () => Promise<T>, timeoutMs = 2 * MINUTE): Promise<T> {
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

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const commit = (cwd: string, message: string) => {
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

describe.runIf(provider !== undefined)(`live ${provider} cycle`, { timeout: 75 * MINUTE }, () => {
  const id = Math.random().toString(36).slice(2, 8);
  const target = 'live';
  // Custom domains (SFORGE_LIVE_DOMAIN): new names, so no earlier run's records get in the way.
  const domain = parentDomain === undefined ? undefined : `t-${id}.${parentDomain}`;
  const previewDomain =
    parentDomain === undefined || provider !== 'aws' ? undefined : `p-${id}.${parentDomain}`;
  const custom =
    domain === undefined
      ? {}
      : {
          domain,
          ...(previewDomain !== undefined && { previewDomain }),
          dns: { provider: 'cloudflare', zone: dnsZone },
        };
  let dir = '';
  let url = '';
  let provisioned = false;

  beforeAll(async () => {
    const account = await cloudAccount();
    if (process.env.SFORGE_LIVE_CONFIRM !== account) {
      throw new Error(
        `This test creates and destroys resources in ${provider} account ${account}. ` +
          `Set SFORGE_LIVE_CONFIRM=${account} to run it.`,
      );
    }
    if (domain !== undefined && (dnsZone === undefined || !process.env.CLOUDFLARE_API_TOKEN)) {
      throw new Error(
        'SFORGE_LIVE_DOMAIN needs SFORGE_LIVE_DNS_ZONE (its Cloudflare zone) and CLOUDFLARE_API_TOKEN.',
      );
    }
    // Outside the per-run temp root (vitest.global-setup.ts), which is deleted when the run
    // ends: if destroy fails, the project is still there to destroy from.
    dir = mkdtempSync(join(dirname(tmpdir()), `sforge-live-${id}-`));
    const example = new URL('../../../examples/basic-site/', import.meta.url).pathname;
    for (const part of ['content', 'assets', 'static'])
      cpSync(join(example, part), join(dir, part), { recursive: true });
    writeFileSync(
      join(dir, 'staticforge.config.json'),
      JSON.stringify({
        site: { title: 'Live test', baseUrl: 'https://live.example.com', author: 'staticforge' },
        styles: ['/assets/css/site.css'],
        scripts: ['/assets/js/site.js'],
        collections: { blog: { dir: 'content/blog', perPage: 2 } },
        iac: { name: `sforge-live-${id}` },
        targets: {
          [target]:
            provider === 'aws'
              ? {
                  provider: 'aws',
                  region: process.env.SFORGE_LIVE_REGION ?? 'eu-north-1',
                  ...custom,
                }
              : {
                  provider: 'azure',
                  resourceGroup: `rg-sforge-live-${id}`,
                  location: 'eastus2',
                  sku: 'Free',
                  state: { location: 'northeurope' },
                  ...custom,
                },
        },
      }),
    );
    // As `sforge init` writes it.
    writeFileSync(
      join(dir, '.gitignore'),
      'node_modules/\ndist/\n.sforge/cache/\n.sforge/state/\n.sforge/iac/**/.terraform/\n',
    );
    // Versions record their commit; Azure rolls back by rebuilding it, but only from a
    // clean checkout.
    git(dir, 'init', '-q');
    commit(dir, 'v1');
  }, 5 * MINUTE);

  afterAll(async () => {
    if (!provisioned) return;
    try {
      await sforge(dir, 'destroy', target, '--confirm', target);
    } catch (error) {
      console.error(
        `Destroy failed; clean up with: sforge destroy ${target} --confirm ${target} --cwd ${dir}\n`,
        error,
      );
      throw error;
    }
    if (domain !== undefined && dnsZone !== undefined) {
      // Destroy removes the validation and routing records it created.
      expect(await cloudflareRecords(dnsZone, id)).toEqual([]);
    }
    rmSync(dir, { recursive: true, force: true });
  }, 30 * MINUTE);

  it('provisions, with a remote state backend, and then has nothing to change', async () => {
    provisioned = true; // even a failed apply may have created something
    const result = await sforge(dir, 'provision', target, '--bootstrap-state', '--yes');
    expect(result.applied).toBe(true);
    url = String(result.outputs.url).replace(/\/$/, '');
    if (domain !== undefined && dnsZone !== undefined) {
      expect(url).toBe(`https://${domain}`);
      const records = await cloudflareRecords(dnsZone, id);
      expect(records).toContain(`${domain} CNAME`);
      if (provider === 'aws') {
        // Certificate validation for the domain and the preview wildcard, and the wildcard itself.
        expect(records).toContain(`*.${previewDomain} CNAME`);
        expect(records.filter((r) => r.startsWith('_'))).toHaveLength(2);
      }
    }
    const plan = await sforge(dir, 'provision', target, '--diff');
    expect(plan.plan.changes).toBe(false);
    // The IaC workspace is meant to be committed (docs/content/deploy.md).
    commit(dir, 'Provision');
  });

  it('deploys, and serves the site with production URL semantics and headers', async () => {
    const first = await sforge(dir, 'deploy', target, '--no-headless');
    expect(first.dryRun).toBe(false);

    // A new custom domain may need a while: DNS, and on Azure the managed certificate.
    // fetch verifies the certificate, so this also checks it covers the domain.
    const home = await eventually(
      async () => {
        const response = await fetch(`${url}/`);
        if (response.status !== 200) throw new Error(`GET / → ${response.status}`);
        return response;
      },
      domain === undefined ? 2 * MINUTE : 15 * MINUTE,
    );
    const html = await home.text();
    expect(html).toContain('<html lang="en"');
    if (domain !== undefined) {
      // Production builds use the target's domain, not site.baseUrl.
      expect(html).toContain(`<link rel="canonical" href="https://${domain}/"`);
    }
    expect(home.headers.get('strict-transport-security')).toMatch(/max-age=\d+/);
    expect(home.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(home.headers.get('x-content-type-options')).toBe('nosniff');
    expect(home.headers.get('cache-control')).toContain('must-revalidate');

    const redirect = await fetch(`${url}/about`, { redirect: 'manual' });
    expect([301, 302, 307, 308]).toContain(redirect.status);
    expect(redirect.headers.get('location')).toMatch(/\/about\/$/);

    const missing = await fetch(`${url}/no/such/page/`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain('there is no page at this address');

    expect((await fetch(`${url}/.sforge/build-manifest.json`)).status).toBe(404);

    const css = await fetch(`${url}/assets/theme/css/theme.css`);
    expect(css.headers.get('content-type')).toContain('text/css');

    if (provider === 'aws') {
      // The bucket is private: only CloudFront may read it.
      const status = await sforge(dir, 'status', target);
      const { bucket, bucket_region: region } = status.outputs as Record<string, string>;
      const direct = await fetch(
        `https://${bucket}.s3.${region}.amazonaws.com/v/${first.versionId}/index.html`,
      );
      expect(direct.status).toBe(403);
    }
  });

  it('deploys a change, keeps the infrastructure free of drift, and rolls back', async () => {
    const about = join(dir, 'content', 'about.md');
    writeFileSync(about, `${readFileSync(about, 'utf8')}\n\nLive marker ${id}.\n`);
    commit(dir, 'v2');

    const second = await sforge(dir, 'deploy', target, '--no-headless');
    if (provider === 'aws') expect(second.copied).toBeGreaterThan(0);
    await eventually(async () => {
      const text = await (await fetch(`${url}/about/`)).text();
      if (!text.includes(`Live marker ${id}`)) throw new Error('the change is not live yet');
    });

    const status = await sforge(dir, 'status', target);
    expect(status.drifted).toBe(false);
    expect(status.versionId).toBe(second.versionId);

    const versions = await sforge(dir, 'versions', target);
    expect(versions.versions.filter((v: { preview: boolean }) => !v.preview)).toHaveLength(2);

    await sforge(dir, 'rollback', target, '--yes');
    await eventually(async () => {
      const text = await (await fetch(`${url}/about/`)).text();
      if (text.includes(`Live marker ${id}`)) throw new Error('the rollback is not live yet');
    }, 10 * MINUTE);
  });

  it.runIf(previewDomain !== undefined)(
    'deploys and removes a preview on its own host',
    async () => {
      const preview = await sforge(dir, 'deploy', target, '--preview', 'pr-1', '--no-headless');
      const previewUrl = `https://pr-1.${previewDomain}`;
      expect(String(preview.url).replace(/\/$/, '')).toBe(previewUrl);
      const html = await eventually(async () => {
        const response = await fetch(`${previewUrl}/`);
        if (response.status !== 200) throw new Error(`preview → ${response.status}`);
        return response.text();
      }, 10 * MINUTE);
      expect(html).toContain(`<link rel="canonical" href="${previewUrl}/"`);
      // Production is unaffected.
      expect(await (await fetch(`${url}/`)).text()).not.toContain(previewUrl);

      const removed = await sforge(dir, 'preview-destroy', target, 'pr-1');
      expect(removed.existed).toBe(true);
      await eventually(async () => {
        const status = (await fetch(`${previewUrl}/`)).status;
        if (status !== 404) throw new Error(`removed preview → ${status}`);
      });
    },
  );

  it.runIf(provider === 'azure')('deploys and removes a preview environment', async () => {
    const preview = await sforge(dir, 'deploy', target, '--preview', 'pr-1', '--no-headless');
    await eventually(async () => {
      const response = await fetch(`${String(preview.url).replace(/\/$/, '')}/`);
      if (response.status !== 200) throw new Error(`preview → ${response.status}`);
    });
    const removed = await sforge(dir, 'preview-destroy', target, 'pr-1');
    expect(removed.existed).toBe(true);
  });
});
