/**
 * A problem found while building or checking a site. Shared by the build
 * pipeline and the checker so agents see one shape everywhere.
 */
export interface Diagnostic {
  /** Stable rule identifier, e.g. "img-alt" or "frontmatter-invalid". */
  ruleId: string;
  severity: DiagnosticSeverity;
  message: string;
  /** Project-relative path of the source file. */
  file?: string;
  /** 1-based line and column in `file`. */
  line?: number;
  column?: number;
  /** WCAG success criterion, e.g. "1.1.1". */
  wcag?: string;
  /** Whether `sforge check --fix` can repair it. */
  fixable?: boolean;
  hint?: string;
}

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

const severityRank: Record<DiagnosticSeverity, number> = { error: 0, warning: 1, info: 2 };

/** Sort by file, then position, then severity: the order humans read reports in. */
export function sortDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort(
    (a, b) =>
      (a.file ?? '').localeCompare(b.file ?? '') ||
      (a.line ?? 0) - (b.line ?? 0) ||
      (a.column ?? 0) - (b.column ?? 0) ||
      severityRank[a.severity] - severityRank[b.severity],
  );
}

export function countBySeverity(diagnostics: Diagnostic[]): Record<DiagnosticSeverity, number> {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const d of diagnostics) counts[d.severity]++;
  return counts;
}

/** One-line human rendering: "content/a.md:3:1 warning img-alt Image has no alt text". */
export function formatDiagnostic(d: Diagnostic): string {
  const location =
    d.file === undefined
      ? ''
      : `${d.file}${d.line !== undefined ? `:${d.line}${d.column !== undefined ? `:${d.column}` : ''}` : ''} `;
  const wcag = d.wcag !== undefined ? ` (WCAG ${d.wcag})` : '';
  return `${location}${d.severity} ${d.ruleId} ${d.message}${wcag}`;
}
