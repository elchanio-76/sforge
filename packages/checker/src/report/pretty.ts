import type { Diagnostic } from '@staticforge/core';
import type { CheckResult } from '../check.js';

const ANSI = {
  error: '\x1b[31m',
  warning: '\x1b[33m',
  info: '\x1b[36m',
  dim: '\x1b[90m',
  reset: '\x1b[0m',
};

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Human-readable report, grouped by file. A problem that appears at the same
 * place on several pages (usually the theme) is listed once, with its pages.
 */
export function formatPretty(result: CheckResult, options: { color?: boolean } = {}): string {
  const paint = (key: keyof typeof ANSI, text: string): string =>
    options.color ? `${ANSI[key]}${text}${ANSI.reset}` : text;

  // Output and rendered findings have no line; group the identical ones across pages.
  const repeated = new Map<string, Diagnostic[]>();
  for (const d of result.diagnostics) {
    if (d.line !== undefined) continue;
    const key = [d.ruleId, d.severity, d.message, d.selector ?? ''].join('\u0000');
    repeated.set(key, [...(repeated.get(key) ?? []), d]);
  }
  const shared = [...repeated.values()].filter((group) => group.length > 1);
  const sharedSet = new Set(shared.flat());

  const byFile = new Map<string, Diagnostic[]>();
  for (const d of result.diagnostics) {
    if (sharedSet.has(d)) continue;
    const key = d.file ?? d.url ?? '(site)';
    byFile.set(key, [...(byFile.get(key) ?? []), d]);
  }

  const line = (d: Diagnostic, location: string): string[] => {
    const wcag = d.wcag !== undefined ? paint('dim', ` WCAG ${d.wcag}`) : '';
    const fixable = d.fixable ? paint('dim', ' (fixable)') : '';
    const out = [
      `  ${location.padEnd(7)} ${paint(d.severity, d.severity.padEnd(7))} ${d.message}${wcag}${fixable}  ${paint('dim', d.ruleId)}`,
    ];
    const where = [
      d.file !== undefined && d.url !== undefined && d.line === undefined
        ? `on ${d.url}`
        : undefined,
      d.selector !== undefined ? `at ${d.selector}` : undefined,
    ].filter((s) => s !== undefined);
    if (where.length > 0) out.push(paint('dim', `          ${where.join(' ')}`));
    if (d.hint !== undefined) out.push(paint('dim', `          ${d.hint}`));
    return out;
  };

  const lines: string[] = [];
  for (const [file, diagnostics] of byFile) {
    lines.push(file);
    for (const d of diagnostics) {
      lines.push(...line(d, d.line !== undefined ? `${d.line}:${d.column ?? 1}` : ''));
    }
    lines.push('');
  }
  if (shared.length > 0) {
    lines.push('On several pages (likely the theme or a shared template)');
    for (const group of shared) {
      const first = group[0] as Diagnostic;
      const urls = group.map((d) => d.url ?? d.file ?? '?');
      const shown =
        urls.slice(0, 3).join(', ') + (urls.length > 3 ? `, +${urls.length - 3} more` : '');
      lines.push(...line({ ...first, url: undefined, file: undefined } as Diagnostic, ''));
      lines.push(paint('dim', `          on ${plural(group.length, 'page')}: ${shown}`));
    }
    lines.push('');
  }

  const { error, warning, info } = result.summary;
  const fixable = result.diagnostics.filter((d) => d.fixable).length;
  const rendered =
    result.rendered === 'ran'
      ? 'with rendered checks'
      : result.rendered === 'skipped'
        ? 'rendered checks skipped'
        : 'static checks only';
  const mark = result.ok ? paint('info', '✔') : paint('error', '✖');
  let summary =
    `${mark} ${plural(error, 'error')}, ${plural(warning, 'warning')}, ${info} info ` +
    `in ${plural(result.pages, 'page')} (${rendered}, ${result.durationMs}ms)`;
  if (fixable > 0 && result.fixes === undefined) {
    summary += `\n  ${plural(fixable, 'problem')} can be fixed with \`sforge check --fix\``;
  }
  if (result.fixes !== undefined) {
    const files = result.fixes.files;
    const edits = files.reduce((n, f) => n + f.edits, 0);
    summary += result.fixes.applied
      ? `\n  Fixed ${plural(edits, 'problem')} in ${plural(files.length, 'file')}: ${files.map((f) => f.file).join(', ') || 'none'}`
      : `\n  Would fix ${plural(edits, 'problem')} in ${plural(files.length, 'file')} (dry run)`;
  }
  lines.push(summary);
  return lines.join('\n');
}
