import { describe, expect, it } from 'vitest';
import { ErrorCode, ExitCode, SforgeError, toSforgeError } from '../src/index.js';

describe('SforgeError', () => {
  it('maps config errors to the usage exit code', () => {
    const error = new SforgeError(ErrorCode.ConfigInvalid, 'bad');
    expect(error.exitCode).toBe(ExitCode.Usage);
  });

  it('serializes only the fields that are set', () => {
    expect(new SforgeError(ErrorCode.Usage, 'nope').toJSON()).toEqual({
      code: 'SF_USAGE',
      message: 'nope',
    });
    expect(
      new SforgeError(ErrorCode.Usage, 'nope', { details: { a: 1 }, hint: 'try x' }).toJSON(),
    ).toEqual({ code: 'SF_USAGE', message: 'nope', details: { a: 1 }, hint: 'try x' });
  });

  it('wraps unknown errors as internal', () => {
    const cause = new TypeError('boom');
    const error = toSforgeError(cause);
    expect(error.code).toBe(ErrorCode.Internal);
    expect(error.exitCode).toBe(ExitCode.Internal);
    expect(error.cause).toBe(cause);
  });

  it('passes SforgeErrors through unchanged', () => {
    const error = new SforgeError(ErrorCode.TargetNotFound, 'x');
    expect(toSforgeError(error)).toBe(error);
  });
});
