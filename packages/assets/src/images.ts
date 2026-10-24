import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import sharp from 'sharp';

export type ImageFormat = 'avif' | 'webp' | 'jpeg' | 'png';

export interface ImageOptions {
  /** Modern formats to offer, in order of preference. */
  formats: ImageFormat[];
  /** Candidate widths; widths above the image's own are dropped. */
  widths: number[];
  quality: number;
  /** Directory for encoded variants, reused across builds. */
  cacheDir: string;
}

export interface ImageVariant {
  /** Output path, POSIX-relative to the build directory. */
  output: string;
  /** Encoded file in the cache. */
  file: string;
  width: number;
}

export interface OptimizedImage {
  /** Intrinsic size after EXIF orientation, for width/height attributes. */
  width: number;
  height: number;
  /** One entry per modern format, best first; `<source>` elements. */
  sources: { type: string; variants: ImageVariant[] }[];
  /** The original format, for `<img src srcset>`. */
  fallback: { type: string; variants: ImageVariant[] };
}

/** Raster formats staticforge resizes. SVG and GIF (often animated) pass through. */
export const OPTIMIZABLE = /\.(jpe?g|png|webp|avif)$/i;

const MIME: Record<ImageFormat, string> = {
  avif: 'image/avif',
  webp: 'image/webp',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

const EXTENSION: Record<ImageFormat, string> = {
  avif: 'avif',
  webp: 'webp',
  jpeg: 'jpg',
  png: 'png',
};

/** Bump when encoding changes, so cached variants are not reused. */
const CACHE_VERSION = 1;

const formatOf = (path: string): ImageFormat => {
  const ext = posix.extname(path).slice(1).toLowerCase();
  return ext === 'jpg' || ext === 'jpeg' ? 'jpeg' : (ext as ImageFormat);
};

/**
 * Resize and re-encode an image into responsive variants. Variants are named
 * by a hash of the source and the settings, and cached in `cacheDir`, so
 * unchanged images cost one hash per build.
 *
 * @param source  Image file on disk.
 * @param outputBase  Output path stem, e.g. "_assets/img/photo".
 */
export async function optimizeImage(
  source: string,
  outputBase: string,
  options: ImageOptions,
): Promise<OptimizedImage> {
  const input = readFileSync(source);
  const meta = await sharp(input).metadata();
  // EXIF orientations 5–8 swap width and height.
  const rotated = (meta.orientation ?? 1) >= 5;
  const width = (rotated ? meta.height : meta.width) ?? 0;
  const height = (rotated ? meta.width : meta.height) ?? 0;
  if (width === 0 || height === 0) throw new Error(`Cannot read the size of ${source}`);

  // e.g. widths [480, 960, 1600]: a 1200px image gets 480, 960 and 1200; a 300px one only 300.
  const largest = Math.min(width, Math.max(...options.widths));
  const widths = [...new Set([...options.widths.filter((w) => w < largest), largest])].sort(
    (a, b) => a - b,
  );
  const original = formatOf(source);
  const key = createHash('sha256')
    .update(input)
    .update(`\0${CACHE_VERSION}\0${options.quality}`)
    .digest('hex')
    .slice(0, 10);
  mkdirSync(options.cacheDir, { recursive: true });

  const encode = async (format: ImageFormat, w: number): Promise<ImageVariant> => {
    const name = `${posix.basename(outputBase)}-${key}-${w}.${EXTENSION[format]}`;
    const file = join(options.cacheDir, name);
    if (!existsSync(file)) {
      const pipeline = sharp(input).rotate().resize({ width: w, withoutEnlargement: true });
      const encoded = await pipeline
        .toFormat(format, { quality: options.quality, ...(format === 'avif' && { effort: 4 }) })
        .toBuffer();
      // Write then rename, so a concurrent build never reads a partial file.
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, encoded);
      renameSync(temp, file);
    }
    return { output: posix.join(posix.dirname(outputBase), name), file, width: w };
  };

  const formats = options.formats.filter((f) => f !== original);
  const [sources, fallback] = await Promise.all([
    Promise.all(
      formats.map(async (format) => ({
        type: MIME[format],
        variants: await Promise.all(widths.map((w) => encode(format, w))),
      })),
    ),
    Promise.all(widths.map((w) => encode(original, w))).then((variants) => ({
      type: MIME[original],
      variants,
    })),
  ]);
  return { width, height, sources, fallback };
}

/** `a-480.webp 480w, a-960.webp 960w` */
export const srcsetOf = (variants: ImageVariant[], urlOf: (output: string) => string): string =>
  variants.map((v) => `${urlOf(v.output)} ${v.width}w`).join(', ');
