import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createLogger } from '@staticforge/core';
import {
  type IacSpec,
  iacRef,
  init,
  resolveEngine,
  runEngine,
  withDns,
  writeWorkspace,
} from '@staticforge/iac';
import { createCloudflareDns } from '../src/index.js';

const SITE = fileURLToPath(new URL('./fixtures/site', import.meta.url));

/**
 * Generates a workspace with a stand-in site module and the two records
 * modules wired to it, and runs `init -backend=false` + `validate` with
 * OpenTofu (downloaded if needed) and Terraform. Downloads the Cloudflare
 * provider, so it only runs with SFORGE_IAC_TESTS=1 (`pnpm test:iac`).
 */
describe.runIf(process.env.SFORGE_IAC_TESTS === '1')('generated Cloudflare DNS workspaces', () => {
  const logger = createLogger({ level: 'warn' });

  it.each([
    ['tofu', false],
    ['tofu', true],
    ['terraform', false],
  ] as const)(
    'validate with %s (vendored: %s)',
    async (engineName, vendor) => {
      let engine;
      try {
        engine = await resolveEngine({ engine: engineName, logger });
      } catch {
        if (engineName === 'terraform') return; // Terraform is optional.
        throw new Error('OpenTofu could not be resolved');
      }
      const dns = await createCloudflareDns().prepare({
        dns: { provider: 'cloudflare', zone: 'example.com', zoneId: 'a'.repeat(32) },
        owner: 'docs/staging',
        env: { CLOUDFLARE_API_TOKEN: 'unused' },
        logger,
      });
      const site: IacSpec = {
        requiredProviders: {},
        providers: {},
        module: {
          name: 'site',
          dir: SITE,
          inputs: {
            domain: 'docs.example.com',
            validation_record_fqdns: iacRef('module.dns_validation.fqdns'),
          },
        },
        outputs: ['dns_records'],
        backend: { type: 'local', config: {} },
      };
      const spec = withDns(site, dns, [
        { name: 'dns_validation', records: iacRef('module.site.validation_records') },
        { name: 'dns_routing', records: iacRef('module.site.dns_records') },
      ]);
      const dir = mkdtempSync(join(tmpdir(), 'sforge-cloudflare-ws-'));
      writeWorkspace({ dir, spec, vendor });
      await init({ engine, dir, env: process.env, logger }, { noBackend: true });
      const result = await runEngine(engine, ['validate', '-json', '-no-color'], {
        cwd: dir,
        json: false,
      });
      expect(JSON.parse(result.stdout), `${engine.name} validate`).toMatchObject({ valid: true });
    },
    600_000,
  );
});
