// Fails when `pnpm audit --prod` reports a high or critical advisory that is not
// in audit-allowlist.json, or when an allowlist entry has not been reviewed for
// 180 days. Dev dependencies are audited and reported without failing.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const MAX_REVIEW_AGE_DAYS = 180;
const BLOCKING = new Set(['high', 'critical']);

function audit(args) {
  try {
    return JSON.parse(execFileSync('pnpm', ['audit', ...args, '--json'], { encoding: 'utf8' }));
  } catch (error) {
    // pnpm exits non-zero when it finds advisories; the report is still on stdout.
    if (typeof error.stdout === 'string' && error.stdout.trim() !== '') {
      return JSON.parse(error.stdout);
    }
    throw error;
  }
}

const allowlist = JSON.parse(
  readFileSync(new URL('../audit-allowlist.json', import.meta.url), 'utf8'),
);
const allowed = new Map(allowlist.advisories.map((entry) => [entry.id, entry]));
let failed = false;

for (const entry of allowlist.advisories) {
  const age = (Date.now() - Date.parse(entry.reviewed)) / 86_400_000;
  if (!(age <= MAX_REVIEW_AGE_DAYS)) {
    console.error(
      `audit-allowlist: ${entry.id} was last reviewed ${entry.reviewed}; review it again`,
    );
    failed = true;
  }
}

const prod = Object.values(audit(['--prod']).advisories ?? {});
for (const advisory of prod) {
  if (!BLOCKING.has(advisory.severity)) continue;
  const id = advisory.github_advisory_id;
  if (allowed.has(id)) {
    console.log(`allowed: ${id} ${advisory.module_name} (${advisory.severity})`);
    continue;
  }
  console.error(`blocking: ${id} ${advisory.module_name} (${advisory.severity}) ${advisory.url}`);
  failed = true;
}

const dev = Object.values(audit(['--dev']).advisories ?? {});
console.log(
  `production advisories: ${prod.length}; development advisories: ${dev.length} (reported only)`,
);
for (const advisory of dev) {
  console.log(`dev: ${advisory.github_advisory_id} ${advisory.module_name} (${advisory.severity})`);
}

process.exit(failed ? 1 : 0);
