import type { Node } from 'unist';
import type { Diagnostic } from '@staticforge/core';

export type Report = (
  diagnostic: Omit<Diagnostic, 'file' | 'line' | 'column'>,
  node?: Node,
) => void;

/** A reporter that records diagnostics against `file`, at the node's source position. */
export function createReport(file: string, diagnostics: Diagnostic[]): Report {
  return (diagnostic, node) => {
    const start = node?.position?.start;
    diagnostics.push({
      ...diagnostic,
      file,
      ...(start !== undefined && { line: start.line, column: start.column }),
    });
  };
}
