// Smoke test of the published packages: pack every workspace package, install the
// tarballs into a new project with npm (third-party dependencies come from the
// registry), and use the installed `sforge`. Run after `pnpm build`.
// Usage: pnpm test:pack [--keep]
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const keep = process.argv.includes('--keep');
const work = mkdtempSync(join(tmpdir(), 'sforge-pack-'));
const tarballs = join(work, 'tarballs');
const project = join(work, 'project');

const run = (command, args, options = {}) => {
  console.log(`$ ${command} ${args.join(' ')}`);
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    ...options,
  });
};
const check = (condition, message) => {
  if (!condition) throw new Error(`pack test failed: ${message}`);
  console.log(`ok - ${message}`);
};

try {
  mkdirSync(tarballs);
  run('pnpm', ['-r', 'pack', '--pack-destination', tarballs], { cwd: root });
  const files = readdirSync(tarballs).filter((f) => f.endsWith('.tgz'));
  check(files.length === 16, `16 packages packed (${files.length})`);

  // Name of the package in each tarball: "staticforge-core-0.1.0.tgz" → "@staticforge/core".
  const packages = Object.fromEntries(
    files.map((file) => {
      const base = file.replace(/-\d+\.\d+\.\d+(-[\w.]+)?\.tgz$/, '');
      const name =
        base === 'staticforge' ? base : `@staticforge/${base.replace(/^staticforge-/, '')}`;
      return [name, `file:${join(tarballs, file)}`];
    }),
  );
  mkdirSync(project);
  writeFileSync(
    join(project, 'package.json'),
    JSON.stringify(
      {
        private: true,
        type: 'module',
        devDependencies: { staticforge: packages.staticforge },
        // The scoped packages are not on the registry yet: take them from the tarballs.
        overrides: packages,
      },
      null,
      2,
    ),
  );
  run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: project });

  const sforge = (...args) => run('npx', ['--no-install', 'sforge', ...args], { cwd: project });
  check(sforge('version').startsWith('sforge 0.'), 'the installed sforge runs');

  sforge('init', 'site', '--format', 'json', '--title', 'Packed');
  // Enough pages for the build and the checker to use worker threads from dist/.
  for (let i = 0; i < 120; i++) {
    writeFileSync(
      join(project, 'site', 'content', `page-${i}.md`),
      `---\ntitle: Page ${i}\n---\n\nSee [the next page](page-${(i + 1) % 120}.md).\n\n\`\`\`js\nconst n = ${i};\n\`\`\`\n`,
    );
  }
  const build = JSON.parse(sforge('build', '--cwd', 'site', '--json'));
  check(build.ok && build.data.pages.length > 120, `built ${build.data.pages.length} pages`);
  check(
    existsSync(join(project, 'site', 'dist', 'assets', 'theme', 'css', 'theme.css')),
    'the default theme was found and its assets copied',
  );
  const report = JSON.parse(sforge('check', '--cwd', 'site', '--no-headless', '--json'));
  check(report.ok, `checked ${report.data.pages} pages without errors`);
  check(JSON.parse(sforge('schema', 'output', '--json')).ok, 'schemas are available');
  check(
    [
      'aws/terraform/modules/site',
      'azure/terraform/modules/site',
      'azure/terraform/modules/ci-oidc',
      'firebase/terraform/modules/site',
      'firebase/terraform/modules/ci-oidc',
      'firebase/terraform/state-bootstrap',
      'cloudflare/terraform/modules/records',
    ].every((dir) => existsSync(join(project, `node_modules/@staticforge/${dir}/versions.tf`))),
    'the HCL modules are in the packages',
  );
  check(
    ['router.js', 'auth-lambda/index.mjs'].every((file) =>
      existsSync(join(project, `node_modules/@staticforge/aws/terraform/modules/site/${file}`)),
    ),
    'the router function and the sign-in Lambda are in the AWS package',
  );

  // The MCP server answers over stdio.
  const tools = await new Promise((resolve, reject) => {
    const child = spawn('npx', ['--no-install', 'sforge', 'mcp', '--cwd', 'site'], {
      cwd: project,
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      for (const line of out.split('\n').slice(0, -1)) {
        const message = JSON.parse(line);
        if (message.id === 1) {
          child.stdin.write(
            `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
          );
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
        }
        if (message.id === 2) {
          child.stdin.end();
          resolve(message.result.tools.map((t) => t.name));
        }
      }
      out = out.slice(out.lastIndexOf('\n') + 1);
    });
    child.on('error', reject);
    setTimeout(() => reject(new Error('the MCP server did not answer')), 30_000).unref();
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pack-test', version: '1' } } })}\n`,
    );
  });
  check(tools.includes('sforge_build'), `the MCP server lists ${tools.length} tools`);
  console.log('pack test passed');
} finally {
  if (keep) console.log(`Kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
