import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { IAMClient, ListOpenIDConnectProvidersCommand } from '@aws-sdk/client-iam';
import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { CloudFrontKeyValueStoreClient } from '@aws-sdk/client-cloudfront-keyvaluestore';
import { mockClient } from 'aws-sdk-client-mock';
import { describe, expect, it } from 'vitest';
import { createLogger, validateConfig } from '@staticforge/core';
import { init, resolveEngine, runEngine, workspaceDir, writeWorkspace } from '@staticforge/iac';
import { createAwsIacProfile } from '../src/index.js';

/**
 * Generates the real workspaces and runs `init -backend=false` + `validate`
 * with OpenTofu (downloaded if needed) or Terraform. Downloads the AWS
 * provider, so it only runs with SFORGE_IAC_TESTS=1 (`pnpm test:iac`).
 */
describe.runIf(process.env.SFORGE_IAC_TESTS === '1')('generated AWS workspaces', () => {
  const logger = createLogger({ level: 'warn' });

  it.each(['tofu', 'terraform'] as const)(
    'validate with %s',
    async (engineName) => {
      mockClient(STSClient).on(GetCallerIdentityCommand).resolves({ Account: '123456789012' });
      mockClient(S3Client).on(HeadBucketCommand).resolves({});
      mockClient(IAMClient)
        .on(ListOpenIDConnectProvidersCommand)
        .resolves({ OpenIDConnectProviderList: [] });
      const clients = {
        s3: () => new S3Client({ region: 'eu-central-1' }),
        sts: () => new STSClient({ region: 'eu-central-1' }),
        iam: () => new IAMClient({ region: 'us-east-1' }),
        cloudfront: () => new CloudFrontClient({ region: 'us-east-1' }),
        kvs: () => new CloudFrontKeyValueStoreClient({ region: 'us-east-1' }),
      };
      let engine;
      try {
        engine = await resolveEngine({ engine: engineName, logger });
      } catch {
        if (engineName === 'terraform') return; // Terraform is optional.
        throw new Error('OpenTofu could not be resolved');
      }
      const config = validateConfig({
        site: { title: 'Docs', baseUrl: 'https://docs.example.com' },
        targets: {
          staging: {
            provider: 'aws',
            region: 'eu-central-1',
            domain: 'docs.example.com',
            hostedZone: 'example.com',
            previewDomain: 'preview.example.com',
            ci: { repo: 'acme/docs', environments: ['staging'] },
          },
        },
      });
      const rootDir = mkdtempSync(join(tmpdir(), 'sforge-aws-ws-'));
      const prepared = await createAwsIacProfile(clients).prepare({
        rootDir,
        config,
        targetName: 'staging',
        target: config.targets.staging!,
        env: process.env,
        logger,
      });
      for (const [name, spec] of [
        ['staging', prepared.spec],
        ['state', prepared.state.bootstrap],
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
