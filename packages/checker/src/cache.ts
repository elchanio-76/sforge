import { Memo } from '@staticforge/build';
import type { Finding } from './types.js';

/**
 * State kept between checks of the same project (`sforge dev`), so a check
 * after a rebuild only re-runs rules whose inputs changed. Keys cover every
 * input of a rule's result.
 */
export class CheckCache {
  /** Source-rule findings by source text, page and the page-URL map. */
  readonly sources = new Memo<Finding[]>();
  /** html-validate findings by page and HTML. */
  readonly validated = new Memo<Finding[]>();
  /** Element ids by page HTML. */
  readonly ids = new Memo<Set<string>>();
  /** Output-rule findings by page HTML and the files and ids of the whole site. */
  readonly output = new Memo<Finding[]>();
  /** Pages whose rules ran in the last check, per kind of rule. */
  stats = { sources: 0, validated: 0, output: 0 };

  begin(): void {
    for (const memo of [this.sources, this.validated, this.ids, this.output]) memo.begin();
    this.stats = { sources: 0, validated: 0, output: 0 };
  }

  commit(): void {
    for (const memo of [this.sources, this.validated, this.ids, this.output]) memo.commit();
  }
}
