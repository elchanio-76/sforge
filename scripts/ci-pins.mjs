#!/usr/bin/env node
// Refresh the pinned GitHub Actions of `sforge ci init` (packages/cli/src/ci/actions.ts):
// each action's newest vX.Y.Z tag and the commit it points to, looked up with `gh api`.
// Usage: node scripts/ci-pins.mjs [--dry-run]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const file = join(dirname(fileURLToPath(import.meta.url)), '../packages/cli/src/ci/actions.ts');
const dryRun = process.argv.includes('--dry-run');
const gh = (...args) => execFileSync('gh', ['api', ...args], { encoding: 'utf8' }).trim();

const semver = (tag) => tag.slice(1).split('.').map(Number);
const newer = (a, b) => {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

/** The newest vX.Y.Z tag (a repo's latest release can be something else, e.g. a CodeQL bundle). */
function newestTag(repo) {
  const tags = gh(`repos/${repo}/tags?per_page=100`, '--paginate', '--jq', '.[].name')
    .split('\n')
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
  if (tags.length === 0) throw new Error(`${repo} has no vX.Y.Z tags`);
  return tags.reduce((best, tag) => (newer(tag, best) ? tag : best));
}

let source = readFileSync(file, 'utf8');
const entries = [
  ...source.matchAll(/repo: '([^']+)',\s*sha: '([0-9a-f]{40})',\s*version: '([^']+)'/g),
];
let changed = 0;
for (const [match, repo, sha, version] of entries) {
  const tag = newestTag(repo);
  // Annotated tags point at a tag object: resolve to the commit.
  const commit = gh(`repos/${repo}/commits/${tag}`, '--jq', '.sha');
  if (tag === version && commit === sha) {
    console.log(`${repo} ${version} is current`);
    continue;
  }
  console.log(`${repo} ${version} → ${tag} (${commit})`);
  source = source.replace(match, match.replace(sha, commit).replace(`'${version}'`, `'${tag}'`));
  changed++;
}
if (changed > 0 && !dryRun) writeFileSync(file, source);
console.log(
  changed === 0
    ? 'All pins are current.'
    : `${changed} pin(s) ${dryRun ? 'would change' : 'updated'}.`,
);
