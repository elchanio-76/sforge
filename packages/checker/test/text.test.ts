import { describe, expect, it } from 'vitest';
import { LineIndex, applyEdits } from '../src/text.js';

describe('LineIndex', () => {
  const index = new LineIndex('ab\n  cd\n\nef');

  it('converts between offsets and 1-based positions', () => {
    expect(index.point(0)).toEqual({ line: 1, column: 1 });
    expect(index.point(5)).toEqual({ line: 2, column: 3 });
    expect(index.point(8)).toEqual({ line: 3, column: 1 });
    expect(index.offset({ line: 2, column: 3 })).toBe(5);
    expect(index.offset({ line: 4, column: 2 })).toBe(10);
  });

  it('reports the indentation of a line', () => {
    expect(index.indentAt(6)).toBe('  ');
    expect(index.indentAt(0)).toBe('');
  });
});

describe('applyEdits', () => {
  it('applies edits in any order and keeps offsets valid', () => {
    const { text, skipped } = applyEdits('hello world', [
      { start: 0, end: 5, text: 'goodbye' },
      { start: 11, end: 11, text: '!' },
    ]);
    expect(text).toBe('goodbye world!');
    expect(skipped).toEqual([]);
  });

  it('drops duplicates and skips overlapping edits', () => {
    const insert = { start: 2, end: 2, text: 'X' };
    const { text, skipped } = applyEdits('abcdef', [
      insert,
      { ...insert },
      { start: 1, end: 4, text: '-' },
      { start: 3, end: 5, text: '+' },
    ]);
    // Applied from the end: 3–5, then the insertion at 2; 1–4 overlaps both.
    expect(text).toBe('abXc+f');
    expect(skipped).toEqual([{ start: 1, end: 4, text: '-' }]);
  });
});
