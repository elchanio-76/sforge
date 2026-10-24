import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@staticforge/core';
import { type DevServer, type LiveState, startDevServer } from '../src/index.js';
import { readEvents, tempDir } from './helpers.js';

const config = JSON.stringify({ site: { title: 'Dev', baseUrl: 'https://example.com' } });

let server: DevServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(files: Record<string, string>) {
  const rootDir = tempDir({ 'staticforge.config.json': config, ...files });
  server = await startDevServer({
    loadConfig: () => loadConfig({ cwd: rootDir }),
    host: '127.0.0.1',
    port: 0,
    debounceMs: 20,
  });
  return { rootDir, server };
}

const page = async (url: string) => (await fetch(url)).text();

describe('startDevServer', () => {
  it('serves the site with the live-reload client injected, without touching build.outDir', async () => {
    const { rootDir, server } = await start({ 'content/index.md': '# Welcome\n' });
    expect(server.state).toMatchObject({ id: 1, ok: true, changed: [] });
    const html = await page(`${server.url}/`);
    expect(html).toContain('<h1>Welcome</h1>');
    expect(html).toContain('src="/__sforge/client.js"');
    expect(await page(`${server.url}/__sforge/client.js`)).toContain(
      "new EventSource('/__sforge/events')",
    );
    expect(existsSync(join(rootDir, 'dist'))).toBe(false);
  });

  it('rebuilds on content changes and tells connected browsers to reload', async () => {
    const { rootDir, server } = await start({ 'content/index.md': '# One\n' });
    const events = readEvents(`${server.url}/__sforge/events`, (e) => e.length === 2);
    await new Promise((r) => setTimeout(r, 100)); // let the client connect

    const next = server.nextBuild();
    writeFileSync(join(rootDir, 'content/index.md'), '# Two\n');
    const built = await next;
    expect(built).toMatchObject({ id: 2, ok: true, changed: ['content/index.md'] });
    expect(await page(`${server.url}/`)).toContain('<h1>Two</h1>');

    const [first, second] = (await events) as LiveState[];
    expect(first?.id).toBe(1);
    expect(second).toMatchObject({ id: 2, cssOnly: false });
  });

  it('marks stylesheet-only changes so the client can swap CSS without reloading', async () => {
    const { rootDir, server } = await start({
      'content/index.md': '# Hi\n',
      'assets/site.css': 'a{}',
    });
    const next = server.nextBuild();
    writeFileSync(join(rootDir, 'assets/site.css'), 'a{color:red}');
    await next;
    const events = (await readEvents(
      `${server.url}/__sforge/events`,
      (e) => e.length === 1,
    )) as LiveState[];
    expect(events[0]).toMatchObject({ id: 2, cssOnly: true });
  });

  it('sends diagnostics to the browser and keeps serving the last good build when the config breaks', async () => {
    const { rootDir, server } = await start({ 'content/index.md': '# Hi\n\n![](x.png)\n' });
    const [initial] = (await readEvents(
      `${server.url}/__sforge/events`,
      (e) => e.length === 1,
    )) as LiveState[];
    expect(initial?.diagnostics.map((d) => d.ruleId)).toEqual(['img-alt']);
    expect(initial?.pages).toContainEqual({ url: '/', source: 'content/index.md' });

    const next = server.nextBuild();
    writeFileSync(join(rootDir, 'staticforge.config.json'), '{ "site": {} }');
    const broken = await next;
    expect(broken.ok).toBe(false);
    expect(broken.error?.code).toBe('SF_CONFIG_INVALID');
    expect(await page(`${server.url}/`)).toContain('<h1>Hi</h1>');

    const fixed = server.nextBuild();
    writeFileSync(join(rootDir, 'staticforge.config.json'), config.replace('Dev', 'Fixed'));
    const recovered = await fixed;
    expect(recovered).toMatchObject({ ok: true, changed: ['staticforge.config.json'] });
    expect(await page(`${server.url}/`)).toContain('<title>Fixed</title>');
  });

  it('rebuilds with the latest contents when a file is saved twice in quick succession', async () => {
    const { rootDir, server } = await start({ 'content/index.md': '# One\n' });
    const next = server.nextBuild();
    writeFileSync(join(rootDir, 'content/index.md'), '# Two\n');
    await new Promise((r) => setTimeout(r, 10));
    writeFileSync(join(rootDir, 'content/index.md'), '# Three\n');
    await next;
    expect(await page(`${server.url}/`)).toContain('<h1>Three</h1>');
  });

  it('ignores changes in the output directory and dot-directories', async () => {
    const { rootDir, server } = await start({ 'content/index.md': '# Hi\n' });
    writeFileSync(join(rootDir, '.notes'), 'x');
    mkdirSync(join(rootDir, 'dist'));
    writeFileSync(join(rootDir, 'dist/index.html'), 'x');
    await new Promise((r) => setTimeout(r, 300));
    expect(server.state.id).toBe(1);
  });

  it('removes its temporary builds on close', async () => {
    const before = new Set(
      readdirSync(tmpdir()).filter((n) => n.startsWith('sforge-dev-') && !n.includes('test')),
    );
    const { server: dev } = await start({ 'content/index.md': '# Hi\n' });
    const created = readdirSync(tmpdir()).filter(
      (n) => n.startsWith('sforge-dev-') && !n.includes('test') && !before.has(n),
    );
    expect(created).toHaveLength(1);
    await dev.close();
    server = undefined;
    expect(existsSync(join(tmpdir(), created[0] ?? ''))).toBe(false);
    rmSync(join(tmpdir(), created[0] ?? 'x'), { recursive: true, force: true });
  });
});
