import type { Command } from 'commander';
import { ExitCode, ErrorCode, toSforgeError } from '@staticforge/core';
import { type CommandContext, createContext } from './context.js';
import type { Io } from './io.js';
import { type Envelope, OUTPUT_SCHEMA_VERSION } from './output.js';

/** Mutable state shared by all commands of one CLI invocation. */
export interface Runtime {
  io: Io;
  exitCode: ExitCode;
}

export interface CommandResult<T> {
  data: T;
  /** Defaults to true. False marks a completed run that found failures (exit code 1). */
  ok?: boolean;
  /** Human-readable rendering written to stdout when not in --json mode. */
  text?: string;
}

export interface ActionInput {
  /** Positional arguments in declaration order. */
  args: unknown[];
  /** The command's own (non-global) options. */
  options: Record<string, unknown>;
}

export type Handler<T> = (ctx: CommandContext, input: ActionInput) => Promise<CommandResult<T>>;

/** "config validate" for `sforge config validate`. */
export function commandPath(command: Command): string {
  const names: string[] = [];
  for (let c: Command | null = command; c?.parent; c = c.parent) names.unshift(c.name());
  return names.join(' ');
}

function writeEnvelope(io: Io, envelope: Envelope): void {
  io.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
}

/**
 * Adapt a handler to a commander action: builds the context, renders the result
 * (text or JSON envelope) and maps errors to stable codes and exit codes.
 */
export function action<T>(runtime: Runtime, handler: Handler<T>) {
  return async (...raw: unknown[]): Promise<void> => {
    const command = raw.at(-1) as Command;
    const ctx = createContext(command, runtime.io);
    const name = commandPath(command);

    try {
      const result = await handler(ctx, { args: raw.slice(0, -2), options: command.opts() });
      const ok = result.ok ?? true;
      if (ctx.json) {
        writeEnvelope(runtime.io, {
          schemaVersion: OUTPUT_SCHEMA_VERSION,
          command: name,
          ok,
          data: result.data,
        });
      } else if (result.text !== undefined) {
        runtime.io.stdout.write(result.text.endsWith('\n') ? result.text : `${result.text}\n`);
      }
      runtime.exitCode = ok ? ExitCode.Ok : ExitCode.Failure;
    } catch (thrown) {
      const error = toSforgeError(thrown);
      if (ctx.json) {
        writeEnvelope(runtime.io, {
          schemaVersion: OUTPUT_SCHEMA_VERSION,
          command: name,
          ok: false,
          error: error.toJSON(),
        });
      } else {
        ctx.logger.error(error.message);
        if (error.hint !== undefined) ctx.logger.info(`hint: ${error.hint}`);
      }
      if (error.code === ErrorCode.Internal && thrown instanceof Error && thrown.stack) {
        ctx.logger.debug(thrown.stack);
      }
      runtime.exitCode = error.exitCode;
    }
  };
}
