import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLogger } from '@staticforge/core';
import { createCloudflareDns } from '@staticforge/cloudflare';
import { init, resolveEngine, runEngine, workspaceDir, writeWorkspace } from '@staticforge/iac';
import { createFirebaseIacProfile } from '../src/index.js';
import { fakeFirebase, firebaseConfig } from './fakes.js';

/**
 * Generates the real workspaces and runs `init -backend=false` + `validate`
 * with OpenTofu (downloaded if needed) or Terraform. Downloads the Google
 * providers, so it only runs with SFORGE_IAC_TESTS=1 (`pnpm test:iac`).
 */
describe.runIf(process.env.SFORGE_IAC_TESTS === '1')('generated Firebase workspaces', () => {
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
      const rootDir = mkdtempSync(join(tmpdir(), 'sforge-firebase-ws-'));
      const prepare = (target: Record<string, unknown>) => {
        const config = firebaseConfig(target);
        const fake = fakeFirebase();
        fake.isFirebase = true;
        return createFirebaseIacProfile(fake.clients).prepare({
          rootDir,
          config,
          targetName: 'prod',
          target: config.targets.prod!,
          env: { CLOUDFLARE_API_TOKEN: 'unused' },
          logger,
          purpose: 'provision',
          dns: createCloudflareDns(),
        });
      };
      const plain = await prepare({});
      // A custom domain in Cloudflare, the GitHub Actions identity and an adopted project.
      const full = await prepare({
        domain: 'firebase.docs.example.com',
        dns: { provider: 'cloudflare', zone: 'example.com', zoneId: 'a'.repeat(32) },
        ci: {
          repo: 'acme/docs',
          environments: ['production'],
          subjectPrefix: 'repo:acme@1/docs@2',
        },
      });
      for (const [name, spec] of [
        ['prod', plain.spec],
        ['state', plain.state.bootstrap],
        ['domain', { ...full.spec, ...(full.imports && { imports: full.imports }) }],
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
