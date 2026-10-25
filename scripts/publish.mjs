// Publish every package at its current (lockstep) version: pnpm packs them, which
// turns `workspace:*` into exact versions, and npm publishes the tarballs, the
// scoped packages before `staticforge`. Versions already on the registry are
// skipped, so a failed run can simply be repeated.
// Usage: node scripts/publish.mjs [--provenance] [--dry-run]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const provenance = process.argv.includes('--provenance');
const dryRun = process.argv.includes('--dry-run');
const dir = mkdtempSync(join(tmpdir(), 'sforge-publish-'));

const run = (command, args) =>
  execFileSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });

function published(name, version) {
  try {
    return run('npm', ['view', `${name}@${version}`, 'version']).trim() === version;
  } catch {
    return false; // E404: not published yet
  }
}

try {
  run('pnpm', ['-r', 'pack', '--pack-destination', dir]);
  const tarballs = readdirSync(dir)
    .filter((file) => file.endsWith('.tgz'))
    // The CLI last, so its dependencies exist when it appears.
    .sort((a, b) => Number(a.startsWith('staticforge-0')) - Number(b.startsWith('staticforge-0')));
  for (const file of tarballs) {
    const tarball = join(dir, file);
    const { name, version } = JSON.parse(
      execFileSync('tar', ['-xOzf', tarball, 'package/package.json'], { encoding: 'utf8' }),
    );
    if (published(name, version)) {
      console.log(`skip ${name}@${version}: already published`);
      continue;
    }
    console.log(`publish ${name}@${version}`);
    run('npm', [
      'publish',
      tarball,
      '--access',
      'public',
      ...(provenance ? ['--provenance'] : []),
      ...(dryRun ? ['--dry-run'] : []),
    ]);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
