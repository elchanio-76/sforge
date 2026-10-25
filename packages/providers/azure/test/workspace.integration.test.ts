import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLogger } from '@staticforge/core';
import { createCloudflareDns } from '@staticforge/cloudflare';
import { init, resolveEngine, runEngine, workspaceDir, writeWorkspace } from '@staticforge/iac';
import { createAzureIacProfile } from '../src/index.js';
import { azureConfig, fakeAzure } from './fakes.js';

/**
 * Generates the real workspaces and runs `init -backend=false` + `validate`
 * with OpenTofu (downloaded if needed) or Terraform. Downloads the azurerm
 * provider, so it only runs with SFORGE_IAC_TESTS=1 (`pnpm test:iac`).
 */
describe.runIf(process.env.SFORGE_IAC_TESTS === '1')('generated Azure workspaces', () => {
  const logger = createLogger({ level: 'warn' });

  it.each(['tofu', 'terraform'] as const)(
    'validate with %s',
    async (engineName) => {
      let engine;
      try {
        engine = await resolveEngine({ engine: engineName, logger });
      } catch {
        if (engineName === 'terraform') return; // Terraform is optional.
        throw new Error('OpenTofu could not be resolved');
      }
      const config = azureConfig({ sku: 'Standard' });
      const rootDir = mkdtempSync(join(tmpdir(), 'sforge-azure-ws-'));
      const prepared = await createAzureIacProfile(fakeAzure().clients).prepare({
        rootDir,
        config,
        targetName: 'prod',
        target: config.targets.prod!,
        env: {},
        logger,
      });
      // A custom domain in Cloudflare and the GitHub Actions identity.
      const full = azureConfig({
        domain: 'azure.docs.example.com',
        dns: { provider: 'cloudflare', zone: 'example.com', zoneId: 'a'.repeat(32) },
        ci: {
          repo: 'acme/docs',
          environments: ['production'],
          subjectPrefix: 'repo:acme@1/docs@2',
        },
      });
      const withDomain = await createAzureIacProfile(fakeAzure().clients).prepare({
        rootDir,
        config: full,
        targetName: 'prod',
        target: full.targets.prod!,
        env: { CLOUDFLARE_API_TOKEN: 'unused' },
        logger,
        dns: createCloudflareDns(),
      });
      for (const [name, spec] of [
        ['prod', prepared.spec],
        ['state', prepared.state.bootstrap],
        ['domain', withDomain.spec],
      ] as const) {
        const dir = workspaceDir(rootDir, name);
        writeWorkspace({ dir, spec, vendor: name === 'state' });
        const ws = { engine, dir, env: process.env, logger };
        await init(ws, { noBackend: true });
        const result = await runEngine(engine, ['validate', '-json', '-no-color'], {
          cwd: dir,
          json: false,
        });
        expect(JSON.parse(result.stdout), `${engine.name} validate ${name}`).toMatchObject({
          valid: true,
        });
      }
    },
    600_000,
  );
});
