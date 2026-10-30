import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { get } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MINUTE,
  cloudAccount,
  cloudflareRecords,
  commit,
  eventually,
  git,
  sforge,
} from './live-helpers.js';

/**
 * The full cycle against a real cloud: provision → deploy twice → HTTP checks →
 * rollback → destroy. Creates real (cheap) resources, so it only runs with
 * SFORGE_LIVE=aws|azure|firebase and SFORGE_LIVE_CONFIRM set to the account,
 * subscription or project id it will use (`pnpm test:live`; see docs/content/deploy.md).
 *
 * With SFORGE_LIVE_DOMAIN (a parent such as aws.sforge.example.com) and
 * SFORGE_LIVE_DNS_ZONE (its Cloudflare zone), the target gets the custom domain
 * t-<id>.<parent> with records in Cloudflare (CLOUDFLARE_API_TOKEN), and on AWS
 * previews on *.p-<id>.<parent>.
 */
const provider = process.env.SFORGE_LIVE as 'aws' | 'azure' | 'firebase' | undefined;
const parentDomain = process.env.SFORGE_LIVE_DOMAIN;
const dnsZone = process.env.SFORGE_LIVE_DNS_ZONE;

/** A request on a connection of its own: fails when this edge has no valid certificate yet. */
const freshRequest = (url: string) =>
  new Promise<void>((resolve, reject) => {
    get(url, { agent: false }, (response) => {
      response.resume();
      resolve();
    }).on('error', reject);
  });

/**
 * Poll a page of a new preview until it is served, recording the first refusal and how long
 * it took: Firebase's own "Site Not Found" and the site's 404 page mean different things.
 */
async function servedPreview(pageUrl: string, timeoutMs: number): Promise<Response> {
  const started = Date.now();
  let reported = false;
  const response = await eventually(async () => {
    const answer = await fetch(pageUrl, { redirect: 'manual' });
    if (answer.status !== 200) {
      const body = (await answer.text()).replace(/\s+/g, ' ').slice(0, 200);
      const headers = ['cache-control', 'age', 'x-cache', 'x-served-by']
        .map((name) => `${name}=${answer.headers.get(name)}`)
        .join(' ');
      const failure = `${pageUrl} → ${answer.status} (${headers}): ${body}`;
      if (!reported) process.stderr.write(`First answer: ${failure}\n`);
      reported = true;
      throw new Error(failure);
    }
    return answer;
  }, timeoutMs);
  process.stderr.write(`${pageUrl} served after ${Math.round((Date.now() - started) / 1000)}s\n`);
  return response;
}

// SFORGE_LIVE_AUTH runs the private-site cycle instead (live-auth.integration.test.ts).
describe.runIf(provider !== undefined && process.env.SFORGE_LIVE_AUTH === undefined)(
  `live ${provider} cycle`,
  { timeout: 75 * MINUTE },
  () => {
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
    let account = '';
    /** The tests after the first need its URL: fail at once instead of polling nothing. */
    const requireUrl = () => {
      if (url === '') throw new Error('Provisioning failed (see the first test); skipping');
    };

    beforeAll(async () => {
      account = await cloudAccount(provider!);
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
                : provider === 'firebase'
                  ? // The site ID comes from iac.name, so it is new each run: deleted ones stay taken.
                    { provider: 'firebase', project: account, ...custom }
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
      const provisioning = Date.now();
      const result = await sforge(dir, 'provision', target, '--bootstrap-state', '--yes');
      process.stderr.write(`Provisioned in ${Math.round((Date.now() - provisioning) / 1000)}s\n`);
      if (result.notices?.length > 0)
        process.stderr.write(`Notices: ${result.notices.join(' | ')}\n`);
      expect(result.applied).toBe(true);
      url = String(result.outputs.url).replace(/\/$/, '');
      if (domain !== undefined && dnsZone !== undefined) {
        expect(url).toBe(`https://${domain}`);
        const records = await cloudflareRecords(dnsZone, id);
        if (provider === 'firebase') {
          // Firebase names the records itself: routing and ownership on the domain.
          expect(records.filter((r) => r.startsWith(`${domain} `)).length).toBeGreaterThan(0);
          process.stderr.write(`Records Firebase asked for: ${records.join(', ')}\n`);
        } else {
          expect(records).toContain(`${domain} CNAME`);
        }
        if (provider === 'aws') {
          // Certificate validation for the domain and the preview wildcard, and the wildcard itself.
          expect(records).toContain(`*.${previewDomain} CNAME`);
          expect(records.filter((r) => r.startsWith('_'))).toHaveLength(2);
        }
      }
      const plan = await sforge(dir, 'provision', target, '--diff');
      if (plan.plan.changes)
        process.stderr.write(`Second plan: ${JSON.stringify(plan.plan.resources)}\n`);
      expect(plan.plan.changes).toBe(false);
      // The IaC workspace is meant to be committed (docs/content/deploy.md).
      commit(dir, 'Provision');
    });

    it('deploys, and serves the site with production URL semantics and headers', async () => {
      requireUrl();
      const first = await sforge(dir, 'deploy', target, '--no-headless');
      expect(first.dryRun).toBe(false);

      // A new custom domain may need a while: DNS, and on Azure the managed certificate.
      // fetch verifies the certificate, so this also checks it covers the domain.
      const waiting = Date.now();
      const home = await eventually(
        async () => {
          const response = await fetch(`${url}/`);
          if (response.status !== 200) throw new Error(`GET / → ${response.status}`);
          return response;
        },
        domain === undefined ? 2 * MINUTE : 15 * MINUTE,
      );
      process.stderr.write(
        `Served after a further ${Math.round((Date.now() - waiting) / 1000)}s\n`,
      );
      if (domain !== undefined) {
        // One answer proves one edge: the certificate reaches the others a little later.
        await eventually(async () => {
          for (let i = 0; i < 6; i++) {
            await freshRequest(`${url}/`);
            await new Promise((r) => setTimeout(r, 5_000));
          }
        }, 15 * MINUTE);
      }
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

      if (provider === 'firebase') {
        // A later rule must override the cache class of the rule that covers everything.
        const manifest = JSON.parse(
          readFileSync(join(dir, 'dist', '.sforge', 'build-manifest.json'), 'utf8'),
        ) as { files: Record<string, { cache: string }> };
        const immutable = Object.keys(manifest.files).find(
          (path) => manifest.files[path]!.cache === 'immutable' && !path.startsWith('.'),
        );
        if (immutable === undefined) throw new Error('The example has no fingerprinted files');
        const cached = await fetch(`${url}/${immutable}`);
        expect(cached.status).toBe(200);
        expect(cached.headers.get('cache-control')).toContain('immutable');
        expect(cached.headers.get('x-content-type-options')).toBe('nosniff');

        // WebAssembly only where Pagefind needs it.
        const search = await fetch(`${url}/search/`);
        expect(search.status).toBe(200);
        expect(search.headers.get('content-security-policy')).toContain('wasm-unsafe-eval');
        expect(home.headers.get('content-security-policy')).not.toContain('wasm-unsafe-eval');

        // A trailing slash is for pages: files stay where they are.
        const file = await fetch(`${url}/assets/theme/css/theme.css`, { redirect: 'manual' });
        expect(file.status).toBe(200);
      }

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
      requireUrl();
      const about = join(dir, 'content', 'about.md');
      writeFileSync(about, `${readFileSync(about, 'utf8')}\n\nLive marker ${id}.\n`);
      commit(dir, 'v2');

      const second = await sforge(dir, 'deploy', target, '--no-headless');
      if (provider !== 'azure') expect(second.copied).toBeGreaterThan(0);
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
        requireUrl();
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

    it.runIf(provider === 'azure' || provider === 'firebase')(
      'deploys and removes a preview environment',
      async () => {
        requireUrl();
        const preview = await sforge(dir, 'deploy', target, '--preview', 'pr-1', '--no-headless');
        const previewUrl = String(preview.url).replace(/\/$/, '');
        const html = await (
          await servedPreview(`${previewUrl}/`, provider === 'firebase' ? 10 * MINUTE : 2 * MINUTE)
        ).text();
        if (provider === 'firebase') {
          // The build knew the channel's URL, which only Firebase can name.
          expect(html).toContain(`<link rel="canonical" href="${previewUrl}/"`);
          expect(html).toContain('name="robots" content="noindex"');
        }
        const removed = await sforge(dir, 'preview-destroy', target, 'pr-1');
        expect(removed.existed).toBe(true);
        if (provider === 'firebase') {
          await eventually(async () => {
            const status = (await fetch(`${previewUrl}/`)).status;
            if (status === 200) throw new Error('the removed preview is still served');
          });
        }
      },
    );

    it.runIf(provider === 'firebase')(
      'serves URLs without a trailing slash when the build asks for that',
      async () => {
        requireUrl();
        // A preview is a version with its own serving configuration, so production stays as it is.
        const path = join(dir, 'staticforge.config.json');
        const original = readFileSync(path, 'utf8');
        writeFileSync(
          path,
          JSON.stringify({ ...JSON.parse(original), build: { trailingSlash: 'never' } }),
        );
        try {
          const preview = await sforge(dir, 'deploy', target, '--preview', 'pr-2', '--no-headless');
          const previewUrl = String(preview.url).replace(/\/$/, '');
          const page = await servedPreview(`${previewUrl}/about`, 10 * MINUTE);
          expect(page.headers.get('content-type')).toContain('text/html');
          const redirect = await fetch(`${previewUrl}/about/`, { redirect: 'manual' });
          expect([301, 302, 307, 308]).toContain(redirect.status);
          expect(redirect.headers.get('location')).toMatch(/\/about$/);
          const missing = await fetch(`${previewUrl}/no/such/page`);
          expect(missing.status).toBe(404);
          expect(await missing.text()).toContain('there is no page at this address');
        } finally {
          writeFileSync(path, original);
          await sforge(dir, 'preview-destroy', target, 'pr-2');
        }
      },
    );
  },
);
