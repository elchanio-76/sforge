import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Give each test run its own temp root and delete it afterwards. Workers
 * inherit TMPDIR, so every mkdtemp(tmpdir()) in the tests lands inside it.
 */
export default function setup(): () => void {
  const root = mkdtempSync(join(tmpdir(), 'sforge-tests-'));
  process.env.TMPDIR = root;
  return () => rmSync(root, { recursive: true, force: true });
}
