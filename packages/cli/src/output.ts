import type { SerializedError } from '@staticforge/core';
import { commandDataSchemas, dataDefName, sharedDefs } from './schemas.js';

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

/**
 * JSON Schema of the envelope. `data` is typed per command: the schema of
 * e.g. `sforge build --json` data is `$defs/build-data`.
 */
export function outputJsonSchema(): Record<string, unknown> {
  const commands = commandDataSchemas();
  const defs: Record<string, unknown> = { ...sharedDefs() };
  for (const [command, schema] of Object.entries(commands)) defs[dataDefName(command)] = schema;
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'urn:staticforge:schema:output:v1',
    title: 'staticforge --json output envelope',
    type: 'object',
    required: ['schemaVersion', 'command', 'ok'],
    additionalProperties: false,
    properties: {
      schemaVersion: { const: OUTPUT_SCHEMA_VERSION },
      command: {
        type: 'string',
        description: 'Command path, e.g. "config validate"; empty for usage errors.',
      },
      ok: { type: 'boolean', description: 'False when the command failed or found failures.' },
      data: { description: 'Command-specific result; see the per-command rules below.' },
      error: { $ref: '#/$defs/error' },
    },
    allOf: Object.keys(commands).map((command) => ({
      if: { properties: { command: { const: command } }, required: ['command', 'data'] },
      then: { properties: { data: { $ref: `#/$defs/${dataDefName(command)}` } } },
    })),
    $defs: defs,
  };
}
