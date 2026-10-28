import { describe, expect, it } from 'vitest';
import type { DeployerContext } from '@staticforge/provider-api';
import { rebuildAtCommit } from '../src/rebuild.js';

describe('rollback rebuild', () => {
  it('refuses a history entry that is not a commit hash, before running git', async () => {
    const context = { rootDir: '/nonexistent' } as DeployerContext;
    for (const sha of ['--output=/tmp/x', '-h', 'main', 'abc', '../../etc', '']) {
      await expect(rebuildAtCommit(sha, context)).rejects.toMatchObject({
        message: expect.stringContaining('not a commit hash'),
      });
    }
  });
});
