import { diagnosticJsonSchema } from '@staticforge/core';

/** JSON Schema of `sforge check --json` data (and of a single diagnostic, under $defs). */
export function checkReportJsonSchema(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'urn:staticforge:schema:diagnostics:v1',
    title: 'staticforge check report',
    type: 'object',
    required: ['ok', 'failOn', 'pages', 'rendered', 'diagnostics', 'summary', 'durationMs'],
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', description: 'No diagnostics at or above failOn.' },
      failOn: { enum: ['error', 'warning'] },
      pages: { type: 'integer', minimum: 0, description: 'Built pages checked.' },
      rendered: {
        enum: ['ran', 'skipped', 'off'],
        description: 'Whether headless (axe-core) checks ran; skipped when Chromium is missing.',
      },
      diagnostics: { type: 'array', items: { $ref: '#/$defs/diagnostic' } },
      summary: {
        type: 'object',
        required: ['error', 'warning', 'info'],
        additionalProperties: false,
        properties: {
          error: { type: 'integer', minimum: 0 },
          warning: { type: 'integer', minimum: 0 },
          info: { type: 'integer', minimum: 0 },
        },
      },
      fixes: {
        type: 'object',
        required: ['applied', 'files', 'diff'],
        additionalProperties: false,
        properties: {
          applied: { type: 'boolean', description: 'False for --dry-run.' },
          files: {
            type: 'array',
            items: {
              type: 'object',
              required: ['file', 'ruleIds', 'edits'],
              additionalProperties: false,
              properties: {
                file: { type: 'string' },
                ruleIds: { type: 'array', items: { type: 'string' } },
                edits: { type: 'integer', minimum: 0 },
              },
            },
          },
          diff: { type: 'string', description: 'Unified diff of the fixes.' },
        },
      },
      durationMs: { type: 'integer', minimum: 0 },
    },
    $defs: { diagnostic: diagnosticJsonSchema() },
  };
}
