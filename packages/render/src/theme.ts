import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { ErrorCode, SforgeError } from '@staticforge/core';

const layoutName = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const assetPath = z
  .string()
  .regex(
    /^(?!\/)(?!.*\.\.)[\w./-]+$/,
    'must be a relative path inside the theme assets/ directory',
  );

export const themeManifestSchema = z.strictObject({
  name: z.string().min(1),
  version: z.string().optional(),
  description: z.string().optional(),
  /** Layout used when a page names none. */
  defaultLayout: layoutName.default('page'),
  /** Layouts the theme provides, as `layouts/<name>.njk`. */
  layouts: z.array(layoutName).min(1),
  /** Stylesheets to link on every page, relative to `assets/`. */
  styles: z.array(assetPath).default([]),
  /** ES module scripts to load on every page, relative to `assets/`. */
  scripts: z.array(assetPath).default([]),
});

export type ThemeManifest = z.output<typeof themeManifestSchema>;

export interface Theme {
  manifest: ThemeManifest;
  /** Directory containing theme.json, layouts/, partials/ and assets/. */
  dir: string;
  /** The theme's assets directory (may not exist). */
  assetsDir: string;
}

/** URL prefix theme assets are published under. */
export const THEME_ASSET_PREFIX = '/assets/theme/';

export function themeAssetUrl(path: string): string {
  return THEME_ASSET_PREFIX + path;
}

function locateManifest(spec: string, rootDir: string): string {
  if (spec === 'default') {
    return createRequire(import.meta.url).resolve('@staticforge/theme-default/theme.json');
  }
  if (spec.startsWith('.') || isAbsolute(spec)) {
    const path = join(resolve(rootDir, spec), 'theme.json');
    if (!existsSync(path)) {
      throw new SforgeError(ErrorCode.ThemeNotFound, `No theme.json found in ${dirname(path)}`);
    }
    return path;
  }
  try {
    return createRequire(join(rootDir, 'package.json')).resolve(`${spec}/theme.json`);
  } catch (error) {
    throw new SforgeError(ErrorCode.ThemeNotFound, `Theme package "${spec}" is not installed`, {
      cause: error,
      hint: `Install it in the project (npm install ${spec}) or set "theme" to a directory path.`,
    });
  }
}

/**
 * Resolve a theme: "default" (bundled), a directory relative to the project,
 * or an installed npm package that ships a theme.json.
 */
export function loadTheme(spec: string, rootDir: string): Theme {
  const manifestPath = locateManifest(spec, rootDir);
  const dir = dirname(manifestPath);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new SforgeError(ErrorCode.ThemeInvalid, `Cannot read ${manifestPath}: ${String(error)}`, {
      cause: error,
    });
  }
  const result = themeManifestSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw new SforgeError(
      ErrorCode.ThemeInvalid,
      `Invalid ${manifestPath}:\n${issues.map((i) => `  - ${i.path}: ${i.message}`).join('\n')}`,
      { details: { issues } },
    );
  }

  const manifest = result.data;
  const missing = [
    ...manifest.layouts.map((name) => `layouts/${name}.njk`),
    ...manifest.styles.map((path) => `assets/${path}`),
    ...manifest.scripts.map((path) => `assets/${path}`),
  ].filter((path) => !existsSync(join(dir, path)));
  if (!manifest.layouts.includes(manifest.defaultLayout))
    missing.push(`layouts/${manifest.defaultLayout}.njk`);
  if (missing.length > 0) {
    throw new SforgeError(
      ErrorCode.ThemeInvalid,
      `Theme "${manifest.name}" is missing files: ${missing.join(', ')}`,
      {
        details: { missing },
      },
    );
  }

  return { manifest, dir, assetsDir: join(dir, 'assets') };
}
