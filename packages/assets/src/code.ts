import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import browserslist from 'browserslist';
import { build } from 'esbuild';
import { browserslistToTargets, bundleAsync } from 'lightningcss';

export interface CodeResult {
  contents: Buffer;
  /** Problems that did not stop bundling. */
  warnings: string[];
}

/** Browsers the output must support: the widely used, maintained ones. */
export const BROWSERS = 'defaults';

/**
 * Bundle a JavaScript or TypeScript module and its imports into one ES module.
 * Root-relative and remote imports (`/pagefind/pagefind.js`, `https://…`) are
 * left for the browser to load.
 */
export async function bundleScript(
  entry: string,
  options: { minify: boolean },
): Promise<CodeResult> {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: options.minify,
    logLevel: 'silent',
    plugins: [
      {
        name: 'sforge-external-urls',
        setup(b) {
          // esbuild filters are Go regular expressions: no lookahead.
          b.onResolve({ filter: /^(\/|https?:)/ }, (args) =>
            args.kind === 'entry-point' ? undefined : { path: args.path, external: true },
          );
        },
      },
    ],
  });
  const output = result.outputFiles[0];
  return {
    contents: Buffer.from(output?.contents ?? new Uint8Array()),
    warnings: result.warnings.map((w) => w.text),
  };
}

let targets: ReturnType<typeof browserslistToTargets> | undefined;

/**
 * Bundle a stylesheet's `@import`s, add vendor prefixes and lower newer
 * syntax for the supported browsers, and optionally minify.
 */
export async function bundleStyle(
  entry: string,
  options: { minify: boolean },
): Promise<CodeResult> {
  targets ??= browserslistToTargets(browserslist(BROWSERS));
  const warnings: string[] = [];
  const result = await bundleAsync({
    filename: entry,
    minify: options.minify,
    targets,
    errorRecovery: true,
  });
  for (const warning of result.warnings) {
    warnings.push(`${warning.message} (line ${warning.loc.line})`);
  }
  return { contents: Buffer.from(result.code), warnings };
}

/** "css/site.css" → "css/site.3f2a9c1b.css" */
export function fingerprint(path: string, contents: Buffer): string {
  const hash = createHash('sha256').update(contents).digest('hex').slice(0, 8);
  const ext = posix.extname(path);
  return `${path.slice(0, path.length - ext.length)}.${hash}${ext}`;
}
