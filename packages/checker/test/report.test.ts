import { describe, expect, it } from 'vitest';
import type { Diagnostic } from '@staticforge/core';
import { type CheckResult, formatJunit, formatPretty, formatSarif } from '../src/index.js';

const diagnostics: Diagnostic[] = [
  {
    ruleId: 'heading-order',
    severity: 'warning',
    message: 'Heading level skips from h2 to h4',
    file: 'content/a.md',
    line: 7,
    column: 1,
    url: '/a/',
    wcag: '1.3.1',
    fixable: true,
    hint: 'Use an h3 here (###), so the outline has no gaps.',
  },
  ...['/a/', '/b/', '/404.html'].map((url): Diagnostic => ({
    ruleId: 'axe/color-contrast',
    severity: 'error',
    message: 'Elements must meet minimum color contrast ratio thresholds',
    ...(url !== '/404.html' && { file: `content${url.slice(0, -1)}.md` }),
    url,
    selector: '.footer > a',
    wcag: '1.4.3',
    helpUrl: 'https://dequeuniversity.com/rules/axe/4.14/color-contrast',
  })),
  { ruleId: 'link-broken', severity: 'error', message: 'Link to <x> & "y"', url: '/404.html' },
];

const result: CheckResult = {
  ok: false,
  failOn: 'error',
  pages: 3,
  rendered: 'ran',
  diagnostics,
  summary: { error: 4, warning: 1, info: 0 },
  durationMs: 1234,
};

describe('formatPretty', () => {
  it('groups by file and lists problems repeated across pages once', () => {
    const text = formatPretty(result);
    expect(text).toContain(
      'content/a.md\n  7:1     warning Heading level skips from h2 to h4 WCAG 1.3.1 (fixable)  heading-order',
    );
    expect(text).toContain('On several pages (likely the theme or a shared template)');
    expect(text.match(/color contrast/g)).toHaveLength(1);
    expect(text).toContain('on 3 pages: /a/, /b/, /404.html');
    expect(text).toContain('/404.html\n          error   Link to <x> & "y"');
    expect(text).toContain(
      '✖ 4 errors, 1 warning, 0 info in 3 pages (with rendered checks, 1234ms)',
    );
    expect(text).toContain('1 problem can be fixed with `sforge check --fix`');
    expect(text).not.toContain('\x1b[');
    expect(formatPretty(result, { color: true })).toContain('\x1b[31merror');
  });
});

describe('formatSarif', () => {
  const sarif = formatSarif(result, {
    toolVersion: '1.2.3',
    uriPrefix: 'site/',
    fallbackFile: 'staticforge.config.ts',
  }) as {
    version: string;
    runs: {
      tool: {
        driver: {
          version: string;
          rules: { id: string; helpUri?: string; properties: { tags: string[] } }[];
        };
      };
      results: {
        ruleId: string;
        ruleIndex: number;
        level: string;
        message: { text: string };
        locations: {
          physicalLocation: { artifactLocation: { uri: string }; region: Record<string, number> };
        }[];
        partialFingerprints: Record<string, string>;
      }[];
    }[];
  };
  const run = sarif.runs[0];

  it('describes each rule once', () => {
    expect(sarif.version).toBe('2.1.0');
    expect(run?.tool.driver.version).toBe('1.2.3');
    expect(run?.tool.driver.rules.map((r) => r.id)).toEqual([
      'heading-order',
      'axe/color-contrast',
      'link-broken',
    ]);
    expect(run?.tool.driver.rules[1]).toMatchObject({
      helpUri: 'https://dequeuniversity.com/rules/axe/4.14/color-contrast',
      properties: { tags: ['accessibility', 'WCAG 1.4.3'] },
    });
  });

  it('locates results relative to the repository root', () => {
    expect(run?.results[0]).toMatchObject({
      ruleId: 'heading-order',
      ruleIndex: 0,
      level: 'warning',
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: 'site/content/a.md' },
            region: { startLine: 7, startColumn: 1 },
          },
        },
      ],
    });
    // No source file (the generated 404 page): fall back to the config file, line 1.
    expect(run?.results[3]?.locations[0]?.physicalLocation).toEqual({
      artifactLocation: { uri: 'site/staticforge.config.ts' },
      region: { startLine: 1 },
    });
    expect(run?.results[1]?.message.text).toBe(
      'Elements must meet minimum color contrast ratio thresholds (on /a/ at .footer > a)',
    );
  });

  it('gives each result a stable fingerprint', () => {
    const fingerprints = run?.results.map((r) => r.partialFingerprints['staticforge/v1']);
    expect(new Set(fingerprints).size).toBe(diagnostics.length);
    const again = formatSarif(result, { toolVersion: '9.9.9', fallbackFile: 'x' }) as typeof sarif;
    expect(again.runs[0]?.results.map((r) => r.partialFingerprints['staticforge/v1'])).toEqual(
      fingerprints,
    );
  });
});

describe('formatJunit', () => {
  it('reports problems at or above failOn as failures, escaping XML', () => {
    const xml = formatJunit(result);
    expect(xml).toMatch(
      /^<\?xml version="1.0" encoding="UTF-8"\?>\n<testsuites name="sforge check" tests="5" failures="4" time="1.234">/,
    );
    expect(xml).toContain('<testsuite name="content/a.md" tests="2" failures="1">');
    expect(xml).toContain('<system-out>content/a.md:7:1 warning heading-order');
    expect(xml).toContain(
      '<failure type="link-broken" message="Link to &lt;x&gt; &amp; &quot;y&quot;">',
    );
    expect(formatJunit({ ...result, failOn: 'warning' })).toContain('failures="5"');
  });
});
