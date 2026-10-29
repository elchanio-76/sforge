// Publish every package at its current (lockstep) version: pnpm packs them, which
// turns `workspace:*` into exact versions, and npm publishes the tarballs, the
// scoped packages before `staticforge`. Versions already on the registry are
// skipped, so a failed run can simply be repeated.
// npm publish runs attached to the terminal, so with 2FA it can show its browser
// link or ask for a one-time password. Prereleases (0.2.0-rc.1) go to the `next`
// dist-tag, so `npm install staticforge` keeps getting the latest release.
// The two 409s npm gave with 0.3.0 (RELEASING.md) are retried: a transparency-log
// collision after a pause, "previously staged version" by waiting until the registry
// serves the version. Any other failure stops the run.
// Usage: node scripts/publish.mjs [--provenance] [--dry-run] [--otp=<code>]
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const root = new URL('..', import.meta.url).pathname;
const provenance = process.argv.includes('--provenance');
const dryRun = process.argv.includes('--dry-run');
const otp = process.argv.find((arg) => arg.startsWith('--otp='));
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

const TLOG_CONFLICT = /TLOG_CREATE_ENTRY_ERROR|equivalent entry already exists/;
const STAGED_CONFLICT = /Cannot publish over previously staged version/;

/** `npm publish`, stderr shown and kept so a known 409 can be told from other failures. */
function publish(tarball, version) {
  const result = spawnSync(
    'npm',
    [
      'publish',
      tarball,
      '--access',
      'public',
      ...(version.includes('-') ? ['--tag', 'next'] : []),
      ...(provenance ? ['--provenance'] : []),
      ...(dryRun ? ['--dry-run'] : []),
      ...(otp ? [otp] : []),
    ],
    { cwd: root, encoding: 'utf8', stdio: ['inherit', 'inherit', 'pipe'] },
  );
  process.stderr.write(result.stderr ?? '');
  return { ok: result.status === 0, stderr: result.stderr ?? '' };
}

async function publishWithRetry(name, version, tarball) {
  for (let attempt = 1; ; attempt++) {
    const result = publish(tarball, version);
    if (result.ok) return;
    if (attempt < 4 && TLOG_CONFLICT.test(result.stderr)) {
      console.log(`${name}: transparency log conflict; retrying in 30 s (attempt ${attempt})`);
      await sleep(30_000);
    } else if (STAGED_CONFLICT.test(result.stderr)) {
      // npm accepted an earlier publish and has not made it visible yet (once: six minutes).
      console.log(`${name}@${version} is staged; waiting for the registry (up to 15 min)`);
      for (let i = 0; i < 30; i++) {
        await sleep(30_000);
        if (published(name, version)) return;
      }
      throw new Error(`${name}@${version} did not appear on the registry`);
    } else {
      throw new Error(`npm publish failed for ${name}@${version}`);
    }
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
    await publishWithRetry(name, version, tarball);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
