import { parseDocument } from 'yaml';
import type { Diagnostic } from '@staticforge/core';

/** Matches a leading YAML block fenced by `---` lines. */
const FENCE = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

export interface FrontMatter {
  /** Whether the file started with a `---` block. */
  present: boolean;
  data: Record<string, unknown>;
  /**
   * The rest of the file. The front-matter is replaced by blank lines so line
   * numbers in later diagnostics still match the source file.
   */
  body: string;
  /** Line of each top-level key, for pointing diagnostics at the right place. */
  keyLines: Record<string, number>;
  diagnostics: Diagnostic[];
}

export function extractFrontMatter(source: string, file: string): FrontMatter {
  const text = source.startsWith('﻿') ? source.slice(1) : source;
  const match = FENCE.exec(text);
  if (match === null) {
    return { present: false, data: {}, body: text, keyLines: {}, diagnostics: [] };
  }

  const yamlText = match[1] ?? '';
  const consumedLines = match[0].split('\n').length - 1;
  const body = '\n'.repeat(consumedLines) + text.slice(match[0].length);
  const diagnostics: Diagnostic[] = [];

  const keyLines: Record<string, number> = {};
  yamlText.split(/\r?\n/).forEach((line, index) => {
    const key = /^([A-Za-z_][\w-]*)\s*:/.exec(line)?.[1];
    if (key !== undefined) keyLines[key] = index + 2; // +1 for 1-based, +1 for the opening fence
  });

  const doc = parseDocument(yamlText);
  for (const error of doc.errors) {
    const pos = error.linePos?.[0];
    diagnostics.push({
      ruleId: 'frontmatter-yaml',
      severity: 'error',
      message: `Invalid YAML front-matter: ${error.message.split('\n')[0]}`,
      file,
      line: pos !== undefined ? pos.line + 1 : 1,
      ...(pos !== undefined && { column: pos.col }),
    });
  }
  if (doc.errors.length > 0) return { present: true, data: {}, body, keyLines, diagnostics };

  const data: unknown = doc.toJS();
  if (data === null || data === undefined) {
    return { present: true, data: {}, body, keyLines, diagnostics };
  }
  if (typeof data !== 'object' || Array.isArray(data)) {
    diagnostics.push({
      ruleId: 'frontmatter-yaml',
      severity: 'error',
      message: 'Front-matter must be a YAML mapping of keys to values',
      file,
      line: 1,
    });
    return { present: true, data: {}, body, keyLines, diagnostics };
  }
  return { present: true, data: data as Record<string, unknown>, body, keyLines, diagnostics };
}
