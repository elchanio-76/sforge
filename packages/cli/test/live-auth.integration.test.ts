import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { createRequire } from 'node:module';
import { lookup as dnsLookup } from 'node:dns';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrowserType } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MINUTE,
  cloudAccount,
  cloudflareRecords,
  commit,
  eventually,
  fromAws,
  git,
  sforge,
} from './live-helpers.js';

/**
 * The private-site cycle against a real cloud (SFORGE_LIVE=aws|azure with
 * SFORGE_LIVE_AUTH=1; see live.integration.test.ts for SFORGE_LIVE_CONFIRM and
 * the custom-domain variables). SFORGE_LIVE_PRIVATE_DNS=1 (with a domain)
 * adds privateDns: nothing but validation records is published, and requests
 * reach the site by its CloudFront or Static Web Apps address.
 *
 * AWS signs in headlessly as a throwaway Cognito user (no email is sent).
 * Azure sign-in needs a real Microsoft or GitHub account: the test checks that
 * anonymous visitors are sent to sign in, prints an invitation link, and with
 * SFORGE_LIVE_KEEP=1 leaves the site up for a manual check (then destroy it with
 * the printed command).
 */
const provider = process.env.SFORGE_LIVE as 'aws' | 'azure' | undefined;
const enabled = provider !== undefined && process.env.SFORGE_LIVE_AUTH !== undefined;
const parentDomain = process.env.SFORGE_LIVE_DOMAIN;
const dnsZone = process.env.SFORGE_LIVE_DNS_ZONE;
const privateDns = process.env.SFORGE_LIVE_PRIVATE_DNS !== undefined;
const keep = process.env.SFORGE_LIVE_KEEP !== undefined;

interface Response {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/**
 * GET over HTTPS without following redirects. `hosts` maps a name to the host
 * whose address to connect to (private DNS); the certificate is still checked
 * against the requested name.
 */
function get(url: string, hosts: Record<string, string>, cookie?: string): Promise<Response> {
  const target = new URL(url);
  const via = (name: string) =>
    hosts[name] ??
    Object.entries(hosts).find(
      ([pattern]) => pattern.startsWith('*.') && name.endsWith(pattern.slice(1)),
    )?.[1] ??
    name;
  return new Promise((resolve, reject) => {
    const req = request(
      target,
      {
        headers: cookie === undefined ? {} : { cookie },
        lookup: (name, options, callback) => dnsLookup(via(name), options, callback),
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe.runIf(enabled)(`live ${provider} private site`, { timeout: 90 * MINUTE }, () => {
  const id = Math.random().toString(36).slice(2, 8);
  const target = 'live';
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
          ...(privateDns && { privateDns: true }),
        };
  let dir = '';
  let url = '';
  let outputs: Record<string, unknown> = {};
  /** Private DNS: where the domain (and preview hosts) really live. */
  let hosts: Record<string, string> = {};
  let provisioned = false;
  const requireUrl = () => {
    if (url === '') throw new Error('Provisioning failed (see the first test); skipping');
  };

  beforeAll(async () => {
    const account = await cloudAccount(provider!);
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
    if (privateDns && domain === undefined) {
      throw new Error('SFORGE_LIVE_PRIVATE_DNS needs SFORGE_LIVE_DOMAIN.');
    }
    dir = mkdtempSync(join(dirname(tmpdir()), `sforge-live-auth-${id}-`));
    const example = new URL('../../../examples/basic-site/', import.meta.url).pathname;
    for (const part of ['content', 'assets', 'static'])
      cpSync(join(example, part), join(dir, part), { recursive: true });
    writeFileSync(
      join(dir, 'staticforge.config.json'),
      JSON.stringify({
        site: { title: 'Private live test', baseUrl: 'https://live.example.com' },
        styles: ['/assets/css/site.css'],
        scripts: ['/assets/js/site.js'],
        // The example's blog links to its feeds.
        collections: { blog: { dir: 'content/blog', perPage: 2 } },
        iac: { name: `sforge-auth-${id}` },
        targets: {
          [target]:
            provider === 'aws'
              ? {
                  provider: 'aws',
                  region: process.env.SFORGE_LIVE_REGION ?? 'eu-north-1',
                  auth: { sessionHours: 1 },
                  ...custom,
                }
              : {
                  provider: 'azure',
                  resourceGroup: `rg-sforge-auth-${id}`,
                  location: 'eastus2',
                  sku: 'Free',
                  state: { location: 'northeurope' },
                  auth: { providers: ['aad', 'github'] },
                  ...custom,
                },
        },
      }),
    );
    writeFileSync(
      join(dir, '.gitignore'),
      'node_modules/\ndist/\n.sforge/cache/\n.sforge/state/\n.sforge/iac/**/.terraform/\n',
    );
    git(dir, 'init', '-q');
    commit(dir, 'v1');
  }, 5 * MINUTE);

  afterAll(async () => {
    if (!provisioned) return;
    const command = `sforge destroy ${target} --confirm ${target} --cwd ${dir}`;
    if (keep) {
      console.error(`SFORGE_LIVE_KEEP: the site stays up at ${url}. Remove it with: ${command}`);
      return;
    }
    try {
      await sforge(dir, 'destroy', target, '--confirm', target);
    } catch (error) {
      console.error(`Destroy failed; clean up with: ${command}\n`, error);
      throw error;
    }
    if (domain !== undefined && dnsZone !== undefined) {
      expect(await cloudflareRecords(dnsZone, id)).toEqual([]);
    }
    rmSync(dir, { recursive: true, force: true });
  }, 30 * MINUTE);

  it('provisions a private target', async () => {
    provisioned = true;
    const result = await sforge(dir, 'provision', target, '--bootstrap-state', '--yes');
    outputs = result.outputs;
    url = String(outputs.url).replace(/\/$/, '');
    expect(outputs.sign_in_url).toEqual(expect.stringMatching(/^https:\/\//));
    if (domain !== undefined && dnsZone !== undefined) {
      const records = await cloudflareRecords(dnsZone, id);
      if (privateDns) {
        // Validation only: the site's own records are for the internal DNS.
        expect(records.some((r) => r.startsWith(`${domain} `))).toBe(false);
        expect(records.length).toBeGreaterThan(0);
        expect(outputs.dns_private_records).toEqual(
          expect.arrayContaining([expect.objectContaining({ name: domain, type: 'CNAME' })]),
        );
        const address = String(
          provider === 'aws' ? outputs.distribution_domain : outputs.default_host_name,
        );
        hosts = {
          [domain]: address,
          ...(previewDomain !== undefined && { [`*.${previewDomain}`]: address }),
        };
      } else {
        expect(records).toContain(`${domain} CNAME`);
      }
    }
    expect((await sforge(dir, 'provision', target, '--diff')).plan.changes).toBe(false);
  });

  it('deploys, and sends anonymous visitors to sign in on every URL', async () => {
    requireUrl();
    await sforge(dir, 'deploy', target, '--no-headless');
    const paths = [
      '/',
      '/about/',
      '/no/such/page/',
      '/sitemap.xml',
      '/assets/theme/css/theme.css',
      '/search/',
      ...(provider === 'aws' ? ['/_sforge/errors/404.html', '/_sforge/versions.json'] : []),
      ...(provider === 'azure' ? ['/404.html', '/_sforge/denied.html'] : []),
    ];
    // A new custom domain may need a while (DNS, certificates): fetch checks the certificate.
    await eventually(
      async () => {
        const home = await get(`${url}/`, hosts);
        if (home.status !== 302) throw new Error(`GET / → ${home.status}`);
      },
      domain === undefined ? 5 * MINUTE : 20 * MINUTE,
    );
    for (const path of paths) {
      const response = await get(`${url}${path}`, hosts);
      expect([301, 302], `${path} → ${response.status}`).toContain(response.status);
      const location = String(response.headers.location);
      expect(location, path).toMatch(
        provider === 'aws' ? /\/_sforge\/auth\/login\?return=/ : /\/\.auth\/login\/aad/,
      );
      expect(response.body, path).not.toContain('Welcome');
    }
    if (provider === 'azure') {
      // Only the configured providers can be used.
      expect((await get(`${url}/.auth/login/twitter`, hosts)).status).toBe(404);
    }
  });

  it.runIf(provider === 'aws')(
    'signs a user in, serves pages, previews and assets, and signs out',
    async () => {
      requireUrl();
      const email = `sforge-live-${id}@example.com`;
      const password = `Live-${id}-${Math.random().toString(36).slice(2, 10)}A1`;
      const cognito = (await import(
        fromAws.resolve('@aws-sdk/client-cognito-identity-provider')
      )) as Record<string, new (input: object) => unknown> & {
        CognitoIdentityProviderClient: new (config: object) => {
          send(command: unknown): Promise<unknown>;
        };
      };
      const client = new cognito.CognitoIdentityProviderClient({
        region: process.env.SFORGE_LIVE_REGION ?? 'eu-north-1',
      });
      const pool = String(outputs.auth_user_pool_id);
      // A throwaway user: no invitation email, and a permanent password.
      await client.send(
        new cognito.AdminCreateUserCommand!({
          UserPoolId: pool,
          Username: email,
          MessageAction: 'SUPPRESS',
          UserAttributes: [
            { Name: 'email', Value: email },
            { Name: 'email_verified', Value: 'true' },
          ],
        }),
      );
      await client.send(
        new cognito.AdminSetUserPasswordCommand!({
          UserPoolId: pool,
          Username: email,
          Password: password,
          Permanent: true,
        }),
      );
      const listed = await sforge(dir, 'users', 'list', target);
      expect(listed.users.map((u: { name: string }) => u.name)).toContain(email);

      const fromChecker = createRequire(new URL('../../checker/package.json', import.meta.url));
      // playwright-core is a dependency of the checker, not of the CLI.
      const { chromium } = (await import(fromChecker.resolve('playwright-core'))) as {
        chromium: BrowserType;
      };
      const mapped = Object.entries(hosts).map(([name, address]) => `MAP ${name} ${address}`);
      const browser = await chromium.launch({
        headless: true,
        ...(process.env.SFORGE_CHROMIUM_PATH && {
          executablePath: process.env.SFORGE_CHROMIUM_PATH,
        }),
        ...(mapped.length > 0 && { args: [`--host-resolver-rules=${mapped.join(', ')}`] }),
      });
      try {
        const page = await browser.newPage();
        // Every response the browser saw (without query strings, which hold codes and
        // tokens), to explain a failed sign-in.
        const trail: string[] = [];
        page.on('response', (response) => {
          const at = new URL(response.url());
          const location = response.headers().location;
          trail.push(
            `${response.status()} ${at.origin}${at.pathname}` +
              (location ? ` → ${location.split('?')[0]}` : ''),
          );
        });
        const heading = async () => {
          try {
            return await page.locator('h1').first().textContent({ timeout: 10_000 });
          } catch {
            const body = (await page.content()).replace(/\s+/g, ' ').slice(0, 600);
            throw new Error(
              `No heading at ${page.url()}\n${trail.slice(-30).join('\n')}\nPage: ${body}`,
            );
          }
        };
        await page.goto(`${url}/about/`);
        // Cognito's managed login: email, then password (one or two steps).
        await page.getByLabel(/email/i).first().fill(email);
        const passwordField = page.getByLabel(/password/i).first();
        if (!(await passwordField.isVisible())) {
          await page
            .getByRole('button', { name: /next|continue|sign in/i })
            .first()
            .click();
        }
        await passwordField.fill(password);
        await page
          .getByRole('button', { name: /^(sign in|continue|next)$/i })
          .first()
          .click();
        await page.waitForURL(`${url}/about/`, { timeout: MINUTE });
        expect(await heading()).toBeTruthy();
        const css = await page.request.get(`${url}/assets/theme/css/theme.css`);
        expect(css.status()).toBe(200);
        expect(css.headers()['content-type']).toContain('text/css');
        const html = await page.request.get(`${url}/`);
        expect(html.headers()['cache-control']).toContain('private');
        expect(await html.text()).toContain('<meta name="robots" content="noindex">');

        if (previewDomain !== undefined) {
          await sforge(dir, 'deploy', target, '--preview', 'pr-1', '--no-headless');
          const previewUrl = `https://pr-1.${previewDomain}`;
          // Signed in to Cognito already: the handoff gives the preview host its cookie.
          await eventually(async () => {
            await page.goto(`${previewUrl}/about/`);
            if (page.url() !== `${previewUrl}/about/`) throw new Error(`at ${page.url()}`);
          }, 10 * MINUTE);
          expect(await page.content()).toContain(
            `<link rel="canonical" href="${previewUrl}/about/"`,
          );
          await sforge(dir, 'preview-destroy', target, 'pr-1');
        }

        await page.goto(`${url}/_sforge/auth/logout`);
        await page.goto(`${url}/about/`);
        expect(page.url()).not.toBe(`${url}/about/`);

        // Signing in again, then revoking every session, signs the browser out.
        await page.getByLabel(/email/i).first().fill(email);
        if (!(await passwordField.isVisible())) {
          await page
            .getByRole('button', { name: /next|continue|sign in/i })
            .first()
            .click();
        }
        await passwordField.fill(password);
        await page
          .getByRole('button', { name: /^(sign in|continue|next)$/i })
          .first()
          .click();
        await page.waitForURL(`${url}/about/`, { timeout: MINUTE });
        await sforge(dir, 'users', 'revoke-sessions', target, '--yes');
        await eventually(async () => {
          const response = await page.request.get(`${url}/`, { maxRedirects: 0 });
          if (response.status() !== 302) throw new Error(`still signed in (${response.status()})`);
        }, 10 * MINUTE);
      } finally {
        await browser.close();
      }

      const removed = await sforge(dir, 'users', 'remove', target, email, '--yes');
      expect(removed.removed).toBe(true);
    },
  );

  it.runIf(provider === 'azure')('invites a user with a link to pass on', async () => {
    requireUrl();
    const invited = await sforge(dir, 'users', 'invite', target, 'octocat', '--provider', 'github');
    expect(invited).toMatchObject({ emailed: false, provider: 'github' });
    expect(invited.invitationUrl).toMatch(/^https:\/\//);
    console.error(
      `Invitation for the GitHub user octocat: ${invited.invitationUrl}\n` +
        `For a manual check, invite your own account (sforge users invite ${target} <you> --cwd ${dir}) and run with SFORGE_LIVE_KEEP=1.`,
    );
  });
});
