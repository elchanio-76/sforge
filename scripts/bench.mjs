// Benchmark: build, check and dev rebuilds of a synthetic site, against the built packages.
// Usage: pnpm build && pnpm bench [--pages 2000] [--json] [--keep]
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const pkg = (name) => new URL(`../packages/${name}/dist/index.js`, import.meta.url).href;
const { buildSite } = await import(pkg('build'));
const { checkBuild } = await import(pkg('checker'));
const { loadConfig } = await import(pkg('core'));
const { startDevServer } = await import(pkg('dev-server'));
const sharp = createRequire(new URL('../packages/assets/package.json', import.meta.url))('sharp');

const { values: args } = parseArgs({
  options: {
    pages: { type: 'string', default: '2000' },
    json: { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
  },
});
const pageCount = Number(args.pages);
if (!Number.isInteger(pageCount) || pageCount < 4)
  throw new Error('--pages must be an integer ≥ 4');

const TAGS = ['aws', 'azure', 'css', 'html', 'a11y', 'news', 'release', 'guide'];
const CODE = `\`\`\`ts
export function greet(name: string): string {
  const words = ['Hello', name].filter(Boolean);
  return \`\${words.join(', ')}!\`;
}
\`\`\``;

/** A synthetic project: guides, a blog collection, tags, code, links and a few images. */
async function generate(dir) {
  const posts = Math.floor(pageCount / 4);
  const guides = pageCount - posts;
  writeFileSync(
    join(dir, 'staticforge.config.json'),
    JSON.stringify({
      site: { title: 'Bench', baseUrl: 'https://bench.example.com' },
      collections: { blog: { dir: 'content/blog', perPage: 20 } },
      check: { headless: false },
    }),
  );
  mkdirSync(join(dir, 'content', 'guides'), { recursive: true });
  mkdirSync(join(dir, 'content', 'blog'), { recursive: true });
  mkdirSync(join(dir, 'content', 'images'), { recursive: true });
  mkdirSync(join(dir, 'assets', 'css'), { recursive: true });
  writeFileSync(join(dir, 'assets', 'css', 'site.css'), 'main { max-width: 50rem; }\n');
  for (let i = 0; i < 5; i++) {
    await sharp({
      create: { width: 1600, height: 900, channels: 3, background: { r: 40 * i, g: 90, b: 160 } },
    })
      .jpeg()
      .toFile(join(dir, 'content', 'images', `photo-${i}.jpg`));
  }
  writeFileSync(
    join(dir, 'content', 'index.md'),
    '---\ntitle: Bench\n---\n\nA synthetic site. See [the blog](blog/_index.md).\n',
  );
  writeFileSync(join(dir, 'content', 'blog', '_index.md'), '---\ntitle: Blog\n---\n\nPosts.\n');

  // Links are relative to the page's own directory (content/guides or content/blog).
  const body = (i, kind) => {
    const link = (j) => {
      const target = j % 4 === 0 ? `blog/post-${j}.md` : `guides/guide-${j % guides}.md`;
      const here = kind === 'post' ? 'blog/' : 'guides/';
      return target.startsWith(here) ? target.slice(here.length) : `../${target}`;
    };
    const image = i % 50 === 0 ? `\n![Photo ${i}](../images/photo-${i % 5}.jpg)\n` : '';
    return `Intro paragraph for ${kind} ${i} with **bold**, _emphasis_ and \`code\`.

## Background

Related: [one](${link(i + 1)}), [two](${link(i + 7)}).
${image}
- first item
- second item with a [link](${link(i + 13)})

## Example

${CODE}

### Details

| Column | Value |
| ------ | ----- |
| index  | ${i}  |
`;
  };

  for (let i = 0; i < guides; i++) {
    const tags = [TAGS[i % TAGS.length]];
    writeFileSync(
      join(dir, 'content', 'guides', `guide-${i}.md`),
      `---\ntitle: Guide ${i}\ntags: [${tags}]\n---\n\n${body(i, 'guide')}`,
    );
  }
  for (let i = 0; i < posts; i++) {
    const date = new Date(Date.UTC(2026, 0, 1) + i * 3600_000).toISOString().slice(0, 10);
    writeFileSync(
      join(dir, 'content', 'blog', `post-${i * 4}.md`),
      `---\ntitle: Post ${i * 4}\ndate: ${date}\ntags: [${TAGS[i % TAGS.length]}, news]\n---\n\n${body(i * 4, 'post')}`,
    );
  }
}

const time = async (fn) => {
  const started = performance.now();
  const value = await fn();
  return { ms: Math.round(performance.now() - started), value };
};

const dir = mkdtempSync(join(tmpdir(), 'sforge-bench-'));
const results = [];
const record = (step, ms, extra = {}) => results.push({ step, ms, ...extra });
try {
  await generate(dir);
  const { config, rootDir } = await loadConfig({ cwd: dir });

  const cold = await time(() => buildSite({ rootDir, config }));
  if (!cold.value.ok) throw new Error(`Build failed: ${JSON.stringify(cold.value.diagnostics[0])}`);
  record('cold build', cold.ms, { pages: cold.value.pages.length, files: cold.value.fileCount });

  const warm = await time(() => buildSite({ rootDir, config }));
  record('warm build (image cache)', warm.ms);

  const check = await time(() =>
    checkBuild({ rootDir, config, build: warm.value, headless: false }),
  );
  record('check (static rules)', check.ms, { findings: check.value.findings.length });

  // Dev rebuilds: time from the file change to the finished build (debounce of 60 ms included).
  const dev = await startDevServer({
    loadConfig: () => loadConfig({ cwd: dir }),
    host: '127.0.0.1',
    port: 0,
    debounceMs: 60,
  });
  try {
    record('dev: first build', dev.state.result?.durationMs ?? 0);
    const rebuild = async (step, change) => {
      const next = dev.nextBuild();
      const started = performance.now();
      change();
      const state = await next;
      if (state.error !== undefined) throw new Error(`${step}: ${state.error.message}`);
      record(step, Math.round(performance.now() - started), { build: state.result?.durationMs });
    };
    const page = join(dir, 'content', 'guides', 'guide-1.md');
    const original = readFileSync(page, 'utf8');
    await rebuild('dev: edit a page body', () =>
      writeFileSync(page, original.replace('Intro paragraph', 'Edited paragraph')),
    );
    // A new title changes the navigation and lists of every page that shows it.
    await rebuild('dev: edit a page title', () =>
      writeFileSync(page, original.replace('title: Guide 1', 'title: Guide One')),
    );
    await rebuild('dev: edit CSS', () =>
      writeFileSync(join(dir, 'assets', 'css', 'site.css'), 'main { max-width: 52rem; }\n'),
    );
    await rebuild('dev: add a page', () =>
      writeFileSync(join(dir, 'content', 'guides', 'new.md'), '---\ntitle: New\n---\n\nNew.\n'),
    );
  } finally {
    await dev.close();
  }
} finally {
  if (args.keep) console.error(`Kept ${dir}`);
  else rmSync(dir, { recursive: true, force: true });
}

const meta = { pages: pageCount, cpus: availableParallelism(), node: process.versions.node };
if (args.json) {
  console.log(JSON.stringify({ ...meta, results }, null, 2));
} else {
  console.log(`sforge bench: ${meta.pages} pages, ${meta.cpus} CPUs, node ${meta.node}`);
  for (const r of results) {
    const extra = Object.entries(r)
      .filter(([k]) => k !== 'step' && k !== 'ms')
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
    console.log(
      `  ${r.step.padEnd(28)} ${String(r.ms).padStart(7)} ms${extra ? `  (${extra})` : ''}`,
    );
  }
}
