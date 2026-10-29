import { posix } from 'node:path';
import { bundleScript, bundleStyle, fingerprint } from '@staticforge/assets';
import type { Diagnostic } from '@staticforge/core';

export interface CodeInput {
  /** Absolute source file. */
  source: string;
  /** Output path, POSIX-relative to the build directory. */
  output: string;
  /** Project-relative label for diagnostics. */
  label: string;
}

export interface CodeOutput {
  output: string;
  contents: Buffer;
  /** Fingerprinted files never change, so they can be cached forever. */
  immutable: boolean;
}

const CODE = /\.(css|js|mjs|ts|mts)$/i;
const TYPESCRIPT = /\.m?ts$/i;

/**
 * Bundle stylesheets (lightningcss) and scripts (esbuild). Each file is
 * written, processed, under its own name (`.ts` as `.js`) and, with
 * `fingerprint`, also under a content-hashed name that references are
 * rewritten to. The hashed file stays in the same directory, so relative
 * `url()`s keep working.
 *
 * @returns The files to write and the URL each source URL now maps to.
 */
export async function processCode(
  inputs: CodeInput[],
  options: { minify: boolean; fingerprint: boolean },
): Promise<{ outputs: CodeOutput[]; urls: Map<string, string>; diagnostics: Diagnostic[] }> {
  const outputs: CodeOutput[] = [];
  const urls = new Map<string, string>();
  const diagnostics: Diagnostic[] = [];

  await Promise.all(
    inputs.map(async (input) => {
      const isStyle = input.output.toLowerCase().endsWith('.css');
      let result;
      try {
        result = isStyle
          ? await bundleStyle(input.source, { minify: options.minify })
          : await bundleScript(input.source, { minify: options.minify });
      } catch (error) {
        diagnostics.push({
          ruleId: 'asset-failed',
          severity: 'error',
          message: `Could not process ${input.label}: ${error instanceof Error ? error.message : String(error)}`,
          file: input.label,
        });
        return;
      }
      for (const warning of result.warnings) {
        diagnostics.push({
          ruleId: 'asset-warning',
          severity: 'warning',
          message: warning,
          file: input.label,
        });
      }

      const plain = TYPESCRIPT.test(input.output)
        ? input.output.replace(TYPESCRIPT, '.js')
        : input.output;
      outputs.push({ output: plain, contents: result.contents, immutable: false });
      let final = plain;
      if (options.fingerprint) {
        final = fingerprint(plain, result.contents);
        outputs.push({ output: final, contents: result.contents, immutable: true });
      }
      urls.set(`/${input.output}`, `/${final}`);
      if (plain !== input.output) urls.set(`/${plain}`, `/${final}`);
    }),
  );
  outputs.sort((a, b) => a.output.localeCompare(b.output));
  return { outputs, urls, diagnostics };
}

/** Whether a copied file is processed as code rather than copied verbatim. */
export const isCode = (output: string): boolean => CODE.test(posix.basename(output));
