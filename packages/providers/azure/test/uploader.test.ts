import { describe, expect, it } from 'vitest';
import { sanitize } from '../src/index.js';

describe('deployment client output', () => {
  it('hides the token and ANSI colors', () => {
    const output = '\u001b[31mFailed with token abc123secret\u001b[0m\nsecond abc123secret line';
    const clean = sanitize(output, 'abc123secret');
    expect(clean).toBe('Failed with token ***\nsecond *** line');
    expect(clean).not.toContain('abc123secret');
  });
});
