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
  /** URL of the built page the problem appears on, e.g. "/about/". */
  url?: string;
  /** CSS selector of the offending element in the built page. */
  selector?: string;
  /** WCAG success criterion, e.g. "1.1.1". */
  wcag?: string;
  /** Whether `sforge check --fix` can repair it. */
  fixable?: boolean;
  hint?: string;
  /** Documentation for the rule. */
  helpUrl?: string;
}

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

const severityRank: Record<DiagnosticSeverity, number> = { error: 0, warning: 1, info: 2 };

/** Sort by file, page, position, then severity: the order humans read reports in. */
export function sortDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort(
    (a, b) =>
      (a.file ?? '').localeCompare(b.file ?? '') ||
      (a.url ?? '').localeCompare(b.url ?? '') ||
      (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER) ||
      (a.column ?? 0) - (b.column ?? 0) ||
      severityRank[a.severity] - severityRank[b.severity],
  );
}

export function countBySeverity(diagnostics: Diagnostic[]): Record<DiagnosticSeverity, number> {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const d of diagnostics) counts[d.severity]++;
  return counts;
}

/** JSON Schema of a {@link Diagnostic}, for `sforge schema diagnostics`. */
export function diagnosticJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    required: ['ruleId', 'severity', 'message'],
    additionalProperties: false,
    properties: {
      ruleId: {
        type: 'string',
        description:
          'Stable rule ID. Rules from html-validate start with "html/", axe-core with "axe/".',
      },
      severity: { enum: ['error', 'warning', 'info'] },
      message: { type: 'string' },
      file: { type: 'string', description: 'Project-relative source file, POSIX separators.' },
      line: { type: 'integer', minimum: 1 },
      column: { type: 'integer', minimum: 1 },
      url: { type: 'string', description: 'URL of the built page, e.g. "/about/".' },
      selector: { type: 'string', description: 'CSS selector of the element in the built page.' },
      wcag: {
        type: 'string',
        pattern: '^\\d\\.\\d\\.\\d+$',
        description: 'WCAG success criterion.',
      },
      fixable: { type: 'boolean', description: 'Whether `sforge check --fix` can repair it.' },
      hint: { type: 'string' },
      helpUrl: { type: 'string', format: 'uri' },
    },
  };
}

/** One-line human rendering: "content/a.md:3:1 warning img-alt Image has no alt text". */
export function formatDiagnostic(d: Diagnostic): string {
  const location =
    d.file === undefined
      ? d.url === undefined
        ? ''
        : `${d.url} `
      : `${d.file}${d.line !== undefined ? `:${d.line}${d.column !== undefined ? `:${d.column}` : ''}` : ''} `;
  const wcag = d.wcag !== undefined ? ` (WCAG ${d.wcag})` : '';
  return `${location}${d.severity} ${d.ruleId} ${d.message}${wcag}`;
}
