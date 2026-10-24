import { createHash } from 'node:crypto';
import type { Diagnostic } from '@staticforge/core';
import type { CheckResult } from '../check.js';

export interface SarifOptions {
  toolVersion: string;
  /**
   * Prefix for file URIs, so they are relative to the repository root as
   * GitHub code scanning expects (e.g. "site/" when the project is in site/).
   */
  uriPrefix?: string;
  /** Location for problems without a source file, e.g. the generated 404 page. */
  fallbackFile: string;
}

const LEVEL = { error: 'error', warning: 'warning', info: 'note' } as const;

/** SARIF 2.1.0 log for GitHub code scanning and other SARIF viewers. */
export function formatSarif(result: CheckResult, options: SarifOptions): Record<string, unknown> {
  const prefix = options.uriPrefix ?? '';
  const rules = new Map<string, { index: number; diagnostic: Diagnostic }>();
  for (const d of result.diagnostics) {
    if (!rules.has(d.ruleId)) rules.set(d.ruleId, { index: rules.size, diagnostic: d });
  }

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'staticforge',
            version: options.toolVersion,
            rules: [...rules].map(([id, { diagnostic: d }]) => ({
              id,
              shortDescription: { text: id },
              ...(d.helpUrl !== undefined && { helpUri: d.helpUrl }),
              properties: {
                tags: ['accessibility', ...(d.wcag !== undefined ? [`WCAG ${d.wcag}`] : [])],
              },
            })),
          },
        },
        results: result.diagnostics.map((d) => {
          const where = [
            d.url !== undefined ? `on ${d.url}` : undefined,
            d.selector !== undefined ? `at ${d.selector}` : undefined,
          ].filter((s) => s !== undefined);
          const text = [
            d.message + (where.length > 0 ? ` (${where.join(' ')})` : ''),
            d.hint,
          ].filter((s) => s !== undefined);
          const fingerprint = createHash('sha256')
            .update([d.ruleId, d.file, d.url, d.selector, d.message].join('\u0000'))
            .digest('hex');
          return {
            ruleId: d.ruleId,
            ruleIndex: rules.get(d.ruleId)?.index ?? 0,
            level: LEVEL[d.severity],
            message: { text: text.join('\n') },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: prefix + (d.file ?? options.fallbackFile) },
                  region: {
                    startLine: d.line ?? 1,
                    ...(d.column !== undefined && { startColumn: d.column }),
                  },
                },
              },
            ],
            partialFingerprints: { 'staticforge/v1': fingerprint },
          };
        }),
      },
    ],
  };
}
