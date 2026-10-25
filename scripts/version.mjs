// Set one version on every published package (they are released in lockstep).
// Usage: node scripts/version.mjs 0.2.0
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version ?? '')) {
  console.error('Usage: node scripts/version.mjs <major.minor.patch[-pre]>');
  process.exit(2);
}
const root = new URL('..', import.meta.url).pathname;
const dirs = ['packages', 'packages/providers'].flatMap((parent) =>
  readdirSync(join(root, parent), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'providers')
    .map((entry) => join(root, parent, entry.name)),
);
for (const dir of dirs) {
  const file = join(dir, 'package.json');
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const pkg = JSON.parse(text);
  pkg.version = version;
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`${pkg.name} ${version}`);
  // A theme's manifest has its own version.
  const theme = join(dir, 'theme.json');
  try {
    const text = readFileSync(theme, 'utf8');
    writeFileSync(theme, text.replace(/"version": "[^"]*"/, `"version": "${version}"`));
  } catch {
    // Not a theme.
  }
}
