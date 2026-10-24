import { z } from 'zod';
import type { Diagnostic } from '@staticforge/core';
import type { FrontMatter } from './frontmatter.js';

const slugPattern = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Known front-matter keys. Unknown keys are kept and exposed to templates as
 * `page.data`, so themes and sites can define their own.
 */
export const pageMetaSchema = z.looseObject({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  layout: z
    .string()
    .regex(slugPattern, 'must be a layout name such as "page" or "post"')
    .optional(),
  date: z.coerce.date().optional(),
  updated: z.coerce.date().optional(),
  tags: z.array(z.string().min(1)).default([]),
  draft: z.boolean().default(false),
  slug: z.string().regex(slugPattern, 'must be lowercase letters, digits and "-"').optional(),
  lang: z
    .string()
    .regex(/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/, 'must be a BCP 47 language tag')
    .optional(),
  nav: z
    .strictObject({
      order: z.number().optional(),
      label: z.string().min(1).optional(),
      hide: z.boolean().default(false),
    })
    .optional(),
});

export type PageMeta = z.output<typeof pageMetaSchema>;

/**
 * Validate front-matter. Invalid keys are reported and dropped, so one bad
 * value doesn't hide the rest of the page's metadata.
 */
export function validatePageMeta(
  frontMatter: FrontMatter,
  file: string,
): { meta: PageMeta; diagnostics: Diagnostic[] } {
  const data = { ...frontMatter.data };
  const diagnostics: Diagnostic[] = [];

  for (let attempt = 0; attempt < 20; attempt++) {
    const result = pageMetaSchema.safeParse(data);
    if (result.success) {
      return {
        meta: result.data,
        diagnostics: diagnostics.sort((a, b) => (a.line ?? 0) - (b.line ?? 0)),
      };
    }

    for (const issue of result.error.issues) {
      const key = String(issue.path[0] ?? '');
      diagnostics.push({
        ruleId: 'frontmatter-invalid',
        severity: 'error',
        message: `Front-matter "${issue.path.join('.')}" ${issue.message}`,
        file,
        line: frontMatter.keyLines[key] ?? 1,
      });
      delete data[key];
    }
  }
  return { meta: pageMetaSchema.parse({}), diagnostics };
}
