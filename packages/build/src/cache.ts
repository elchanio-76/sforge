import { createHash } from 'node:crypto';
import type { PreparedSource } from '@staticforge/content';
import type { ParseResult } from './tasks.js';

/** SHA-256 of the parts, separated so ("ab", "c") and ("a", "bc") differ. */
export function hashOf(...parts: string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part).update('\0');
  return hash.digest('hex');
}

/** JSON for hashing: Maps and Sets as sorted entries. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v instanceof Map) return [...v].sort(([a], [b]) => String(a).localeCompare(String(b)));
    if (v instanceof Set) return [...v].sort();
    return v;
  });
}

/**
 * Results by key, kept for one build: entries a build does not use are
 * dropped when it finishes, so the cache never outgrows the site.
 */
export class Memo<V> {
  private current = new Map<string, V>();
  private next = new Map<string, V>();

  get(key: string): V | undefined {
    const value = this.current.get(key) ?? this.next.get(key);
    if (value !== undefined) this.next.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    this.next.set(key, value);
  }

  /** Start a build: forget what an unfinished one collected. */
  begin(): void {
    this.next = new Map();
  }

  /** Finish a build: keep only what it used. */
  commit(): void {
    this.current = this.next;
    this.next = new Map();
  }

  get size(): number {
    return this.current.size;
  }
}

/**
 * Results for `items`, from `memo` where it has them; the rest are computed in
 * one call (in item order) and kept when `keep` allows.
 */
export async function memoized<I, R>(
  items: I[],
  memo: Memo<R> | undefined,
  keyOf: (item: I) => string,
  compute: (missing: I[]) => Promise<R[]>,
  keep: (result: R) => boolean,
): Promise<{ results: R[]; computed: number }> {
  if (memo === undefined) return { results: await compute(items), computed: items.length };
  const keys = items.map(keyOf);
  const results = keys.map((key) => memo.get(key));
  const missing = results.flatMap((result, i) => (result === undefined ? [i] : []));
  const computed = await compute(missing.map((i) => items[i] as I));
  for (const [j, i] of missing.entries()) {
    const result = computed[j] as R;
    results[i] = result;
    if (keep(result)) memo.set(keys[i] as string, result);
  }
  return { results: results as R[], computed: missing.length };
}

/** A copied file of a build, recognized by its source's size and modification time. */
export interface CopyRecord {
  source: string;
  size: number;
  mtimeMs: number;
  sha256: string;
}

/**
 * State kept between builds of the same project (`sforge dev`), so a rebuild
 * only parses and renders what changed. Every key covers all inputs of its
 * result, so the cache cannot serve stale output; it only saves work.
 */
export class BuildCache {
  /** Template variable `build.time`: fixed, so unchanged pages stay identical. */
  readonly time = new Date();
  readonly prepared = new Memo<PreparedSource>();
  /** Parse results without trees, by source and the page/output sets they resolve against. */
  readonly parsed = new Memo<ParseResult>();
  /** Finished page HTML by everything that went into rendering it. */
  readonly rendered = new Memo<string>();
  /** The last build, whose unchanged files the next one hard-links. */
  previous: { outDir: string; copies: Map<string, CopyRecord> } | undefined;
  /** What the last build did: pages parsed and rendered, files linked. */
  stats = { parsed: 0, rendered: 0, linked: 0 };

  begin(): void {
    this.prepared.begin();
    this.parsed.begin();
    this.rendered.begin();
    this.stats = { parsed: 0, rendered: 0, linked: 0 };
  }

  commit(previous: BuildCache['previous']): void {
    this.prepared.commit();
    this.parsed.commit();
    this.rendered.commit();
    this.previous = previous;
  }
}
