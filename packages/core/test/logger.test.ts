import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, shouldUseColor } from '../src/index.js';

function capture() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(String(chunk));
      done();
    },
  });
  return { stream, output: () => chunks.join('') };
}

describe('createLogger', () => {
  it('filters messages below the configured level', () => {
    const { stream, output } = capture();
    const logger = createLogger({ level: 'warn', stream });
    logger.error('e');
    logger.warn('w');
    logger.info('i');
    logger.debug('d');
    expect(output()).toBe('error e\nwarn w\n');
  });

  it('writes nothing when silent', () => {
    const { stream, output } = capture();
    createLogger({ level: 'silent', stream }).error('e');
    expect(output()).toBe('');
  });

  it('adds ANSI color only when enabled', () => {
    const { stream, output } = capture();
    createLogger({ color: true, stream }).info('hi');
    expect(output()).toBe('\x1b[36minfo\x1b[0m hi\n');
  });
});

describe('shouldUseColor', () => {
  it('honours NO_COLOR over a TTY', () => {
    expect(shouldUseColor({ isTTY: true }, { NO_COLOR: '1' })).toBe(false);
  });

  it('honours FORCE_COLOR without a TTY', () => {
    expect(shouldUseColor({ isTTY: false }, { FORCE_COLOR: '1' })).toBe(true);
    expect(shouldUseColor({ isTTY: true }, { FORCE_COLOR: '0' })).toBe(false);
  });

  it('treats empty variables as unset and falls back to TTY detection', () => {
    expect(shouldUseColor({ isTTY: true }, { NO_COLOR: '', FORCE_COLOR: '' })).toBe(true);
    expect(shouldUseColor({ isTTY: false }, {})).toBe(false);
  });
});
