import { z } from 'zod';
import { configSchema } from './schema.js';

export const CONFIG_SCHEMA_ID = 'urn:staticforge:schema:config:v1';

/** JSON Schema (draft 2020-12) describing the config file as users write it. */
export function configJsonSchema(): Record<string, unknown> {
  return {
    ...z.toJSONSchema(configSchema, { io: 'input', target: 'draft-2020-12' }),
    $id: CONFIG_SCHEMA_ID,
    title: 'staticforge configuration',
  };
}
