import type { SerializedError } from '@staticforge/core';

/** Version of the `--json` envelope. Bump only on breaking changes. */
export const OUTPUT_SCHEMA_VERSION = 1;

/** The single JSON document written to stdout by every command under `--json`. */
export interface Envelope<T = unknown> {
  schemaVersion: typeof OUTPUT_SCHEMA_VERSION;
  command: string;
  ok: boolean;
  data?: T;
  error?: SerializedError;
}

export function outputJsonSchema(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'urn:staticforge:schema:output:v1',
    title: 'staticforge --json output envelope',
    type: 'object',
    required: ['schemaVersion', 'command', 'ok'],
    additionalProperties: false,
    properties: {
      schemaVersion: { const: OUTPUT_SCHEMA_VERSION },
      command: { type: 'string', description: 'Command path, e.g. "config validate".' },
      ok: { type: 'boolean', description: 'False when the command failed or found failures.' },
      data: { description: 'Command-specific result.' },
      error: {
        type: 'object',
        required: ['code', 'message'],
        additionalProperties: false,
        properties: {
          code: { type: 'string', pattern: '^SF_[A-Z_]+$' },
          message: { type: 'string' },
          details: {},
          hint: { type: 'string' },
        },
      },
    },
  };
}
