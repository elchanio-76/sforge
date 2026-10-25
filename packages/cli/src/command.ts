import type { Command } from 'commander';
import { type DnsConfig, ExitCode, ErrorCode, toSforgeError } from '@staticforge/core';
import type { DnsProfile } from '@staticforge/iac';
import type { Provider } from '@staticforge/provider-api';
import { type CommandContext, createContext } from './context.js';
import type { Io } from './io.js';
import { type Envelope, OUTPUT_SCHEMA_VERSION } from './output.js';

/** Mutable state shared by all commands of one CLI invocation. */
export interface Runtime {
  io: Io;
  exitCode: ExitCode;
  /** Cloud providers to use instead of the real ones (tests). */
  providers?: Partial<Record<Provider['id'], Provider>>;
  /** DNS providers to use instead of the real ones (tests). */
  dns?: Partial<Record<DnsConfig['provider'], DnsProfile>>;
  /**
   * Receives every command's outcome, in --json mode or not, before a
   * long-running command starts waiting (in-process callers: the MCP server).
   */
  onResult?(outcome: Outcome): void;
}

export interface Outcome {
  envelope: Envelope;
  /** The human-readable rendering, when the command has one. */
  text?: string;
  /** The current data of a long-running command (e.g. the dev server's latest build). */
  live?: () => unknown;
}

export interface CommandResult<T> {
  data: T;
  /** Defaults to true. False marks a completed run that found failures (exit code 1). */
  ok?: boolean;
  /** Human-readable rendering written to stdout when not in --json mode. */
  text?: string;
  /**
   * For long-running commands (servers): the result is written as soon as the
   * command is ready, then the process stays up until this settles.
   */
  wait?: Promise<void>;
  /** For long-running commands: the current `data`, for {@link Runtime.onResult}. */
  live?: () => T;
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
      const envelope: Envelope = {
        schemaVersion: OUTPUT_SCHEMA_VERSION,
        command: name,
        ok,
        data: result.data,
      };
      runtime.onResult?.({
        envelope,
        ...(result.text !== undefined && { text: result.text }),
        ...(result.live && { live: result.live }),
      });
      if (ctx.json) {
        writeEnvelope(runtime.io, envelope);
      } else if (result.text !== undefined) {
        runtime.io.stdout.write(result.text.endsWith('\n') ? result.text : `${result.text}\n`);
      }
      runtime.exitCode = ok ? ExitCode.Ok : ExitCode.Failure;
      await result.wait;
    } catch (thrown) {
      const error = toSforgeError(thrown);
      const envelope: Envelope = {
        schemaVersion: OUTPUT_SCHEMA_VERSION,
        command: name,
        ok: false,
        error: error.toJSON(),
      };
      runtime.onResult?.({ envelope });
      if (ctx.json) {
        writeEnvelope(runtime.io, envelope);
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
