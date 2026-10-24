import type { Diagnostic } from '@staticforge/core';
import type { CheckResult } from '../check.js';

const xml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

/**
 * JUnit XML: one test suite per file (or page), one test case per problem.
 * Problems at or above `failOn` are failures; the rest pass, with the problem
 * in system-out.
 */
export function formatJunit(result: CheckResult): string {
  const failing = (d: Diagnostic): boolean =>
    d.severity === 'error' || (result.failOn === 'warning' && d.severity === 'warning');

  const suites = new Map<string, Diagnostic[]>();
  for (const d of result.diagnostics) {
    const key = d.file ?? d.url ?? 'site';
    suites.set(key, [...(suites.get(key) ?? []), d]);
  }

  const failures = result.diagnostics.filter(failing).length;
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="sforge check" tests="${result.diagnostics.length}" failures="${failures}" time="${(result.durationMs / 1000).toFixed(3)}">`,
  ];
  for (const [name, diagnostics] of suites) {
    out.push(
      `  <testsuite name="${xml(name)}" tests="${diagnostics.length}" failures="${diagnostics.filter(failing).length}">`,
    );
    for (const d of diagnostics) {
      const location = d.line !== undefined ? `${name}:${d.line}:${d.column ?? 1}` : name;
      const details = [
        `${location} ${d.severity} ${d.ruleId}`,
        d.message,
        d.url !== undefined ? `Page: ${d.url}` : undefined,
        d.selector !== undefined ? `Element: ${d.selector}` : undefined,
        d.wcag !== undefined ? `WCAG: ${d.wcag}` : undefined,
        d.hint,
        d.helpUrl,
      ]
        .filter((s) => s !== undefined)
        .join('\n');
      out.push(
        `    <testcase classname="${xml(name)}" name="${xml(`${d.ruleId}: ${d.message}`)}">`,
      );
      out.push(
        failing(d)
          ? `      <failure type="${xml(d.ruleId)}" message="${xml(d.message)}">${xml(details)}</failure>`
          : `      <system-out>${xml(details)}</system-out>`,
      );
      out.push('    </testcase>');
    }
    out.push('  </testsuite>');
  }
  out.push('</testsuites>', '');
  return out.join('\n');
}
