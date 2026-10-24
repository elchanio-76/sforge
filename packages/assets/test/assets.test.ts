import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { bundleScript, fingerprint, optimizeImage } from '../src/index.js';

const dir = () => mkdtempSync(join(tmpdir(), 'sforge-assets-'));

async function image(
  width: number,
  height: number,
  format: 'jpeg' | 'png',
  options: { orientation?: number } = {},
) {
  const path = join(dir(), `img.${format === 'jpeg' ? 'jpg' : 'png'}`);
  let pipeline = sharp({ create: { width, height, channels: 3, background: '#336699' } }).toFormat(
    format,
  );
  if (options.orientation !== undefined)
    pipeline = pipeline.withMetadata({ orientation: options.orientation });
  await pipeline.toFile(path);
  return path;
}

describe('optimizeImage', () => {
  const options = (cacheDir: string) => ({
    formats: ['avif', 'webp'] as ('avif' | 'webp')[],
    widths: [480, 960, 1600],
    quality: 60,
    cacheDir,
  });

  it('offers each configured width up to the image’s own, plus that width', async () => {
    const result = await optimizeImage(
      await image(1200, 600, 'jpeg'),
      '_assets/img/a',
      options(dir()),
    );
    expect(result).toMatchObject({ width: 1200, height: 600 });
    expect(result.sources.map((s) => [s.type, s.variants.map((v) => v.width)])).toEqual([
      ['image/avif', [480, 960, 1200]],
      ['image/webp', [480, 960, 1200]],
    ]);
    expect(result.fallback.type).toBe('image/jpeg');
    expect(result.fallback.variants[0]?.output).toMatch(/^_assets\/img\/a-[0-9a-f]{10}-480\.jpg$/);
    const meta = await sharp(result.fallback.variants[1]?.file).metadata();
    expect([meta.width, meta.height]).toEqual([960, 480]);
  });

  it('caps at the largest configured width and keeps small images at their size', async () => {
    const large = await optimizeImage(await image(4000, 1000, 'png'), 'x/l', options(dir()));
    expect(large.fallback.variants.map((v) => v.width)).toEqual([480, 960, 1600]);
    const small = await optimizeImage(await image(200, 100, 'png'), 'x/s', options(dir()));
    expect(small.fallback.variants.map((v) => v.width)).toEqual([200]);
  });

  it('reports the displayed size of rotated photos', async () => {
    // EXIF orientation 6: stored 300×200, displayed rotated 90°.
    const result = await optimizeImage(
      await image(300, 200, 'jpeg', { orientation: 6 }),
      'x/r',
      options(dir()),
    );
    expect([result.width, result.height]).toEqual([200, 300]);
    const meta = await sharp(result.fallback.variants[0]?.file).metadata();
    expect([meta.width, meta.height]).toEqual([200, 300]);
  });
});

describe('bundleScript', () => {
  it('bundles imports and leaves root-relative and remote ones to the browser', async () => {
    const root = dir();
    writeFileSync(join(root, 'dep.js'), 'export const n = 41;');
    writeFileSync(
      join(root, 'main.js'),
      "import { n } from './dep.js';\nimport x from 'https://cdn.test/x.js';\nconsole.log(n + 1, x, import('/pagefind/pagefind.js'));",
    );
    const { contents } = await bundleScript(join(root, 'main.js'), { minify: false });
    const code = contents.toString();
    expect(code).toContain('var n = 41;');
    expect(code).toContain('import x from "https://cdn.test/x.js";');
    expect(code).toContain('import("/pagefind/pagefind.js")');
  });
});

describe('fingerprint', () => {
  it('inserts a hash of the contents before the extension', () => {
    expect(fingerprint('assets/css/site.css', Buffer.from('a'))).toBe(
      'assets/css/site.ca978112.css',
    );
    expect(fingerprint('x.js', Buffer.from('b'))).not.toBe(fingerprint('x.js', Buffer.from('a')));
  });
});
