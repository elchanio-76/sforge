import { Ajv2020 } from 'ajv/dist/2020.js';
import { expect } from 'vitest';
import { outputJsonSchema } from '../src/output.js';

// Formats are documentation here; unknown keywords and bad references still fail.
const ajv = new Ajv2020({ allErrors: true, strictTypes: false, validateFormats: false });
const validateEnvelope = ajv.compile(outputJsonSchema());

/** Fail the test unless `envelope` matches `sforge schema output`, including its data. */
export function expectValidEnvelope(envelope: unknown): void {
  const valid = validateEnvelope(envelope);
  expect(valid ? [] : validateEnvelope.errors, JSON.stringify(envelope).slice(0, 2000)).toEqual([]);
}

/** Fail the test unless `data` matches the JSON Schema `schema` (an MCP tool's output schema). */
export function expectMatchesSchema(schema: Record<string, unknown>, data: unknown): void {
  const validate = ajv.compile(schema);
  const valid = validate(data);
  expect(valid ? [] : validate.errors, JSON.stringify(data).slice(0, 2000)).toEqual([]);
}
