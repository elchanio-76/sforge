import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitIsDirty } from '../src/index.js';

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sforge-git-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  writeFileSync(join(dir, 'index.md'), '# Home\n');
  mkdirSync(join(dir, '.sforge', 'iac', 'prod'), { recursive: true });
  writeFileSync(join(dir, '.sforge', 'iac', 'prod', 'terraform.tfvars.json'), '{}\n');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init');
  return dir;
}

describe('gitIsDirty', () => {
  it('ignores the workspaces sforge rewrites in .sforge/', () => {
    const dir = repo();
    expect(gitIsDirty(dir)).toBe(false);
    writeFileSync(join(dir, '.sforge', 'iac', 'prod', 'terraform.tfvars.json'), '{"x":1}\n');
    writeFileSync(join(dir, '.sforge', 'iac', 'prod', 'new.json'), '{}\n');
    expect(gitIsDirty(dir)).toBe(false);
  });

  it('reports changed and new files of the site', () => {
    const dir = repo();
    writeFileSync(join(dir, 'deploy.json'), '{}\n');
    expect(gitIsDirty(dir)).toBe(true);
  });

  it('is false outside a git checkout', () => {
    expect(gitIsDirty(mkdtempSync(join(tmpdir(), 'sforge-nogit-')))).toBe(false);
  });
});
