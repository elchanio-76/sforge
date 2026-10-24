import { HtmlValidate } from 'html-validate';
import type { CheckPage, Finding } from './types.js';

/**
 * html-validate rules that check the same thing as a staticforge rule report
 * under the staticforge ID, so the finding is de-duplicated against (and fixed
 * by) the source rule. Everything else is reported as `html/<rule>`.
 */
const ALIASES: Record<string, string> = {
  'heading-level': 'heading-order',
  'wcag/h37': 'img-alt',
};

/** WCAG success criteria for html-validate's accessibility rules. */
const WCAG: Record<string, string> = {
  'area-alt': '1.1.1',
  'aria-hidden-body': '4.1.2',
  'aria-label-misuse': '4.1.2',
  'empty-heading': '2.4.6',
  'heading-level': '1.3.1',
  'hidden-focusable': '4.1.2',
  'input-missing-label': '1.3.1',
  'meta-refresh': '2.2.1',
  'multiple-labeled-controls': '1.3.1',
  'no-autoplay': '1.4.2',
  'no-redundant-role': '4.1.2',
  'text-content': '4.1.2',
  'unique-landmark': '1.3.1',
  'valid-autocomplete': '1.3.5',
  'wcag/h30': '2.4.4',
  'wcag/h32': '3.2.2',
  'wcag/h36': '1.1.1',
  'wcag/h37': '1.1.1',
  'wcag/h63': '1.3.1',
  'wcag/h67': '1.1.1',
  'wcag/h71': '1.3.1',
};

/** Messages that a staticforge rule reports (with a fix or a better hint): [rule, message text]. */
const COVERED: [string, string][] = [
  ['element-required-content', '<title>'], // document-title
  ['element-required-attributes', '"lang"'], // html-lang
  ['element-required-attributes', '<iframe> is missing required "title"'], // iframe-title
];

let validator: HtmlValidate | undefined;

function getValidator(): HtmlValidate {
  validator ??= new HtmlValidate({
    extends: ['html-validate:standard', 'html-validate:a11y', 'html-validate:document'],
    rules: {
      // Subresource integrity only protects resources from other origins.
      'require-sri': ['error', { target: 'crossorigin' }],
      // Covered by the document-title rule, which can also fix it.
      'empty-title': 'off',
      // Not accessibility problems: worth knowing, not worth failing a build.
      'long-title': 'warn',
      'no-implicit-button-type': 'warn',
      'no-redundant-role': 'warn',
      'prefer-button': 'warn',
      'prefer-native-element': 'warn',
      'prefer-tbody': 'warn',
      'tel-non-breaking': 'warn',
    },
  });
  return validator;
}

/** Validate one built page with html-validate. */
export async function validateHtml(page: CheckPage, html: string): Promise<Finding[]> {
  const report = await getValidator().validateString(html, page.output);
  const findings: Finding[] = [];
  for (const result of report.results) {
    for (const message of result.messages) {
      if (
        COVERED.some(
          ([ruleId, text]) => message.ruleId === ruleId && message.message.includes(text),
        )
      ) {
        continue;
      }
      const wcag = WCAG[message.ruleId];
      findings.push({
        layer: 'output',
        diagnostic: {
          ruleId: ALIASES[message.ruleId] ?? `html/${message.ruleId}`,
          severity: message.severity >= 2 ? 'error' : 'warning',
          message: message.message,
          ...(page.source !== undefined && { file: page.source }),
          url: page.url,
          ...(message.selector !== null && { selector: message.selector }),
          ...(wcag !== undefined && { wcag }),
          ...(message.ruleUrl !== undefined && { helpUrl: message.ruleUrl }),
        },
      });
    }
  }
  return findings;
}
