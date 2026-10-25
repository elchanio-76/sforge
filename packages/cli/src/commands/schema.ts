import { Argument, type Command } from 'commander';
import { checkReportJsonSchema } from '@staticforge/checker/report-schema';
import { configJsonSchema } from '@staticforge/core';
import { type Runtime, action } from '../command.js';
import { outputJsonSchema } from '../output.js';

const schemas = {
  config: configJsonSchema,
  diagnostics: checkReportJsonSchema,
  output: outputJsonSchema,
} as const;

type SchemaName = keyof typeof schemas;

export function registerSchemaCommand(program: Command, runtime: Runtime): void {
  program
    .command('schema')
    .description(
      'Print a JSON Schema: the config file, the check report (diagnostics), or the --json envelope',
    )
    .addArgument(new Argument('<name>', 'schema to print').choices(Object.keys(schemas)))
    .action(
      action(runtime, async (_ctx, { args }) => {
        const schema = schemas[args[0] as SchemaName]();
        return { data: schema, text: JSON.stringify(schema, null, 2) };
      }),
    );
}
