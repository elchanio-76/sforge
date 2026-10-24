/** A replacement of `text[start, end)`, in UTF-16 offsets of the original file. */
export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

export interface Point {
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
}

/** Converts between offsets and line/column positions of one text. */
export class LineIndex {
  private readonly starts: number[] = [0];

  constructor(readonly text: string) {
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) this.starts.push(i + 1);
    }
  }

  offset(point: Point): number {
    const start = this.starts[point.line - 1] ?? this.text.length;
    return Math.min(start + point.column - 1, this.text.length);
  }

  point(offset: number): Point {
    let low = 0;
    let high = this.starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((this.starts[mid] ?? 0) <= offset) low = mid;
      else high = mid - 1;
    }
    return { line: low + 1, column: offset - (this.starts[low] ?? 0) + 1 };
  }

  /** Leading whitespace of the line containing `offset`. */
  indentAt(offset: number): string {
    const start = this.starts[this.point(offset).line - 1] ?? 0;
    return /^[ \t]*/.exec(this.text.slice(start))?.[0] ?? '';
  }
}

/**
 * Apply edits to a text. Edits are applied from the end so offsets stay valid;
 * an edit overlapping one already accepted is dropped and returned in `skipped`.
 */
export function applyEdits(text: string, edits: TextEdit[]): { text: string; skipped: TextEdit[] } {
  const unique = new Map(edits.map((e) => [`${e.start}:${e.end}:${e.text}`, e]));
  const sorted = [...unique.values()].sort((a, b) => b.start - a.start || b.end - a.end);
  const skipped: TextEdit[] = [];
  let result = text;
  let floor = Infinity;
  for (const edit of sorted) {
    if (edit.end > floor) {
      skipped.push(edit);
      continue;
    }
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    floor = edit.start;
  }
  return { text: result, skipped };
}

export const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
