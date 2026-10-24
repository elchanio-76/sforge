/**
 * Process exit codes. These are part of the public CLI contract: scripts and
 * agents branch on them, so values must never change meaning.
 */
export const ExitCode = {
  /** Command succeeded. */
  Ok: 0,
  /** Command ran but found problems at or above the failure threshold (e.g. `check`). */
  Failure: 1,
  /** Bad usage or invalid/missing configuration. */
  Usage: 2,
  /** Unexpected internal error (a bug, or an unhandled environment failure). */
  Internal: 3,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * Stable, machine-readable error codes. Agents match on `code`, never on
 * `message`, so add new codes rather than repurposing existing ones.
 */
export const ErrorCode = {
  Usage: 'SF_USAGE',
  ConfigNotFound: 'SF_CONFIG_NOT_FOUND',
  ConfigLoadFailed: 'SF_CONFIG_LOAD_FAILED',
  ConfigInvalid: 'SF_CONFIG_INVALID',
  TargetNotFound: 'SF_TARGET_NOT_FOUND',
  ThemeNotFound: 'SF_THEME_NOT_FOUND',
  ThemeInvalid: 'SF_THEME_INVALID',
  FileExists: 'SF_FILE_EXISTS',
  UnsafePath: 'SF_UNSAFE_PATH',
  Internal: 'SF_INTERNAL',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

const exitCodeFor: Record<ErrorCode, ExitCode> = {
  SF_USAGE: ExitCode.Usage,
  SF_CONFIG_NOT_FOUND: ExitCode.Usage,
  SF_CONFIG_LOAD_FAILED: ExitCode.Usage,
  SF_CONFIG_INVALID: ExitCode.Usage,
  SF_TARGET_NOT_FOUND: ExitCode.Usage,
  SF_THEME_NOT_FOUND: ExitCode.Usage,
  SF_THEME_INVALID: ExitCode.Usage,
  SF_FILE_EXISTS: ExitCode.Usage,
  SF_UNSAFE_PATH: ExitCode.Usage,
  SF_INTERNAL: ExitCode.Internal,
};

/** JSON shape of an error as emitted in `--json` output. */
export interface SerializedError {
  code: ErrorCode;
  message: string;
  details?: unknown;
  hint?: string;
}

export interface SforgeErrorOptions {
  details?: unknown;
  hint?: string;
  cause?: unknown;
}

/** An expected, user-facing error with a stable code. */
export class SforgeError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;
  readonly hint: string | undefined;

  constructor(code: ErrorCode, message: string, options: SforgeErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'SforgeError';
    this.code = code;
    this.details = options.details;
    this.hint = options.hint;
  }

  get exitCode(): ExitCode {
    return exitCodeFor[this.code];
  }

  toJSON(): SerializedError {
    return {
      code: this.code,
      message: this.message,
      ...(this.details !== undefined && { details: this.details }),
      ...(this.hint !== undefined && { hint: this.hint }),
    };
  }
}

/** Wrap any thrown value as an SforgeError, treating unknown errors as internal. */
export function toSforgeError(error: unknown): SforgeError {
  if (error instanceof SforgeError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new SforgeError(ErrorCode.Internal, message, { cause: error });
}
